import "dotenv/config";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  Task,
  TaskStatus,
  StructuredTimesheet,
  PolicyAuditResult,
  HRValidationReport,
  AuditLogEntry,
} from "./models/task.js";
import { processUnstructuredTimesheet } from "./services/gemini.js";
import {
  PUBSUB_TOPIC,
  subscribeToTopic,
  publishMessage,
} from "./lib/pubsub.js";
import {
  employeesCol,
  jobsCol,
  updateJobStatus,
  createJob,
  EmployeeRecord,
} from "./lib/firestore.js";
import { validateTaskPolicies } from "./utils/validator.js";
import { indexValidatedTask } from "./services/meili.js";

export interface HumanReviewNotification {
  id: string;
  taskId: string;
  employeeId: string;
  employeeName?: string;
  type: "overtime_approval_required" | "policy_violation_alert" | "labor_fatigue_alert";
  title: string;
  message: string;
  severity: "high" | "critical" | "medium";
  overtimeHours: number;
  totalHours: number;
  timestamp: string;
  status: "unread" | "acknowledged" | "resolved";
  actionUrl?: string;
  details?: Record<string, any>;
}

// In-memory store for standardized Task models
export const tasksStore = new Map<string, Task>();

// In-memory store for supervisor review notifications
export const notificationsStore: HumanReviewNotification[] = [];

type NotificationListener = (notification: HumanReviewNotification) => void;
const notificationListeners: NotificationListener[] = [];

export function onHumanReviewNotification(listener: NotificationListener) {
  notificationListeners.push(listener);
}

/**
 * Event-Driven Agentic Workflow Engine for orchestrating HR compliance audits,
 * Gemini semantic extraction, validation, HITL interrupts, and Meilisearch audit indexing.
 */
class AgenticWorkflowEngine extends EventEmitter {
  constructor() {
    super();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.on("JOB_INGESTED", async (eventData: { task: Task; rawText: string }) => {
      const { task } = eventData;
      console.log(`[AgenticWorkflow] Event JOB_INGESTED for task ${task.id}`);
      this.emit("AI_ANALYSIS_STARTED", eventData);
    });

    this.on("AI_ANALYSIS_STARTED", async (eventData: { task: Task; rawText: string }) => {
      const { task, rawText } = eventData;
      try {
        console.log(`[AgenticWorkflow] Executing Gemini 3.5 Flash semantic timesheet parser for task ${task.id}`);
        task.auditLogs.push({
          timestamp: new Date().toISOString(),
          stage: "gemini_parsing",
          actor: "gemini_agent",
          message: "Transforming unstructured shift text into structured timesheet JSON via Gemini 3.5 Flash",
        });

        const structuredTimesheet = await processUnstructuredTimesheet(rawText);
        task.structuredTimesheet = structuredTimesheet;
        task.employeeId = structuredTimesheet.employeeId;

        this.emit("POLICY_VALIDATION_TRIGGERED", { task, structuredTimesheet });
      } catch (err: any) {
        this.emit("WORKFLOW_FAILED", { task, error: err });
      }
    });

    this.on("POLICY_VALIDATION_TRIGGERED", async (eventData: { task: Task; structuredTimesheet: StructuredTimesheet }) => {
      const { task, structuredTimesheet } = eventData;
      try {
        console.log(`[AgenticWorkflow] Running HR policy validation service for task ${task.id}`);
        task.auditLogs.push({
          timestamp: new Date().toISOString(),
          stage: "policy_validation",
          actor: "system",
          message: "Validating extracted timesheet metrics against corporate labor compliance rules",
        });

        let employeeRecord: EmployeeRecord | null = null;
        if (structuredTimesheet.employeeId && structuredTimesheet.employeeId !== "emp_unknown") {
          const empSnap = await employeesCol.doc(structuredTimesheet.employeeId).get();
          if (empSnap.exists) {
            employeeRecord = empSnap.data();
          }
        }

        const { report, auditResults } = await validateTaskPolicies(structuredTimesheet, employeeRecord);

        task.validationReport = report;
        task.policyAuditResults = auditResults;
        task.requiresHumanReview = report.requiresHumanReview;
        task.updatedAt = new Date().toISOString();

        if (report.requiresHumanReview) {
          this.emit("HUMAN_REVIEW_INTERRUPT", { task, report, auditResults, employeeRecord, structuredTimesheet });
        } else {
          this.emit("WORKFLOW_COMPLETED", { task, report, auditResults, employeeRecord, structuredTimesheet });
        }
      } catch (err: any) {
        this.emit("WORKFLOW_FAILED", { task, error: err });
      }
    });

    this.on("HUMAN_REVIEW_INTERRUPT", async (eventData: { task: Task; report: HRValidationReport; auditResults: PolicyAuditResult[]; structuredTimesheet: StructuredTimesheet }) => {
      const { task, report, auditResults, structuredTimesheet } = eventData;
      task.status = "needs_review";
      const violations = auditResults.filter((r) => !r.passed);
      const violationSummary = violations.map((r) => r.violationMessage).join("; ");

      task.auditLogs.push({
        timestamp: new Date().toISOString(),
        stage: "hitl_interrupt",
        actor: "system",
        message: `Execution paused for Human-in-the-Loop review. Violations: ${violationSummary}`,
        details: { violations },
      });

      const notification = triggerHumanReviewNotification(task, violations);

      await updateJobStatus(task.id, "needs_review", {
        message: `Policy Review Required: ${violationSummary}`,
        structuredTimesheet,
        validationReport: report,
        notificationId: notification.id,
      });

      this.emit("AUDIT_INDEXING_TRIGGERED", { task });
    });

    this.on("WORKFLOW_COMPLETED", async (eventData: { task: Task; report: HRValidationReport; employeeRecord: EmployeeRecord | null; structuredTimesheet: StructuredTimesheet }) => {
      const { task, report, employeeRecord, structuredTimesheet } = eventData;
      task.status = "completed";
      task.completedAt = new Date().toISOString();

      task.auditLogs.push({
        timestamp: new Date().toISOString(),
        stage: "completion",
        actor: "system",
        message: "Timesheet validated successfully with 0 policy violations.",
      });

      if (employeeRecord && structuredTimesheet.employeeId) {
        await employeesCol.doc(structuredTimesheet.employeeId).update({
          regularHours: structuredTimesheet.regularHours,
          overtimeHours: structuredTimesheet.overtimeHours,
        });
      }

      await updateJobStatus(task.id, "completed", {
        result: `Timesheet approved. Regular: ${structuredTimesheet.regularHours}h, Overtime: ${structuredTimesheet.overtimeHours}h. Total: ${structuredTimesheet.totalHours}h. All compliance checks passed.`,
        structuredTimesheet,
        validationReport: report,
      });

      this.emit("AUDIT_INDEXING_TRIGGERED", { task });
    });

    this.on("AUDIT_INDEXING_TRIGGERED", async (eventData: { task: Task }) => {
      const { task } = eventData;
      try {
        console.log(`[AgenticWorkflow] Indexing validated task ${task.id} into Meilisearch audit history`);
        await indexValidatedTask(task);
      } catch (meiliErr: any) {
        console.warn(`[AgenticWorkflow] Audit indexing skipped (${meiliErr?.message}).`);
      }
      tasksStore.set(task.id, task);
    });

    this.on("WORKFLOW_FAILED", async (eventData: { task: Task; error: any }) => {
      const { task, error } = eventData;
      const errorMsg = error?.message || String(error);
      console.error(`[AgenticWorkflow] Workflow failed for task ${task.id}:`, errorMsg);

      task.status = "failed";
      task.updatedAt = new Date().toISOString();
      task.auditLogs.push({
        timestamp: new Date().toISOString(),
        stage: "completion",
        actor: "system",
        message: `Processing failed with error: ${errorMsg}`,
      });

      await updateJobStatus(task.id, "error", { message: errorMsg });

      try {
        await indexValidatedTask(task);
      } catch {}

      tasksStore.set(task.id, task);
    });
  }

  public async dispatchJob(taskId: string, tenantId: string, command: string, rawText: string): Promise<Task> {
    const auditLogs: AuditLogEntry[] = [
      {
        timestamp: new Date().toISOString(),
        stage: "ingestion",
        actor: "system",
        message: `Ingested task message for tenant ${tenantId} via Pub/Sub topic ${PUBSUB_TOPIC}`,
        details: { taskId, tenantId },
      },
    ];

    const task: Task = {
      id: taskId,
      jobId: taskId,
      tenantId,
      type: "timesheet_validation",
      status: "running",
      command,
      rawTimesheetText: rawText,
      auditLogs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    tasksStore.set(taskId, task);
    await createJob(taskId, command, tenantId);
    await updateJobStatus(taskId, "running");

    this.emit("JOB_INGESTED", { task, rawText });
    return task;
  }
}

export const workflowEngine = new AgenticWorkflowEngine();

/**
 * Dispatches a notification for Human-in-the-Loop overtime and policy review.
 */
export function triggerHumanReviewNotification(
  task: Task,
  violations: PolicyAuditResult[],
): HumanReviewNotification {
  const timesheet = task.structuredTimesheet;
  const isCritical = violations.some((v) => v.severity === "critical");
  const otViolation = violations.find((v) => v.ruleCode === "overtime_approval_limit");

  const title = otViolation
    ? `⚠️ Overtime Approval Required: ${task.employeeId} (${timesheet?.overtimeHours || 0}h)`
    : `⚠️ Compliance Review Alert: ${task.employeeId}`;

  const message = violations
    .map((v) => v.violationMessage || `${v.policyTitle} exceeded threshold (${v.actualValue} ${v.unit})`)
    .join(". ");

  const notification: HumanReviewNotification = {
    id: `notif_${randomUUID()}`,
    taskId: task.id,
    employeeId: task.employeeId || "emp_unknown",
    employeeName: timesheet?.employeeName,
    type: otViolation ? "overtime_approval_required" : "policy_violation_alert",
    title,
    message,
    severity: isCritical ? "critical" : "high",
    overtimeHours: timesheet?.overtimeHours ?? 0,
    totalHours: timesheet?.totalHours ?? 0,
    timestamp: new Date().toISOString(),
    status: "unread",
    actionUrl: `/?taskId=${task.id}`,
    details: {
      violations,
      recommendedAction: task.validationReport?.recommendedAction,
      department: timesheet?.department,
    },
  };

  notificationsStore.unshift(notification);

  for (const listener of notificationListeners) {
    try {
      listener(notification);
    } catch (err) {
      console.error("[Notification] Error calling notification listener:", err);
    }
  }

  console.log(`[Taskmaster Notification] [${notification.severity.toUpperCase()}] ${notification.title} - ${notification.message}`);
  return notification;
}

/**
 * Validates a structured timesheet against corporate policies and employee records.
 */
export async function validateTimesheetPolicies(
  structuredTimesheet: StructuredTimesheet,
  employeeRecord?: EmployeeRecord | null,
): Promise<{
  report: HRValidationReport;
  auditResults: PolicyAuditResult[];
}> {
  return validateTaskPolicies(structuredTimesheet, employeeRecord);
}

/**
 * Core event handler for timesheet validation messages received via Pub/Sub.
 * Delegates to the AgenticWorkflowEngine event-driven loop.
 */
export async function handleTimesheetMessage(payload: any, ack?: () => void) {
  const taskId = payload.taskId || payload.id || payload.jobId || randomUUID();
  const tenantId = payload.tenantId || "tenant_01";
  const command = payload.command || payload.text || "Validate employee timesheet and policy compliance";
  const rawTimesheetText = payload.rawTimesheetText || payload.timesheet || payload.text || command;

  console.log(`[Taskmaster Subscriber] Ingested message for Task ID: ${taskId} on topic: ${PUBSUB_TOPIC}`);

  try {
    await workflowEngine.dispatchJob(taskId, tenantId, command, rawTimesheetText);
    if (typeof ack === "function") {
      ack();
    }
  } catch (err: any) {
    console.error(`[Taskmaster Subscriber] Error dispatching event loop for task ${taskId}:`, err?.message);
    if (typeof ack === "function") {
      ack();
    }
  }
}

/**
 * Initializes and starts the Pub/Sub subscriber listener for PUBSUB_TOPIC.
 */
export function startPubSubSubscriber() {
  console.log(`[Taskmaster Subscriber] Starting subscription listener for topic: '${PUBSUB_TOPIC}'...`);
  subscribeToTopic(PUBSUB_TOPIC, `${PUBSUB_TOPIC}-sub`, handleTimesheetMessage);
}

// Auto-start subscriber when initialized
startPubSubSubscriber();

export default {
  startPubSubSubscriber,
  handleTimesheetMessage,
  validateTimesheetPolicies,
  triggerHumanReviewNotification,
  workflowEngine,
  notificationsStore,
  tasksStore,
};
