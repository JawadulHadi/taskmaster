import "dotenv/config";
import { randomUUID } from "node:crypto";
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

  // Notify active listeners (e.g. SSE / WebSocket / console)
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
 * Uses the comprehensive validator in `src/utils/validator.ts`.
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
 */
export async function handleTimesheetMessage(payload: any, ack?: () => void) {
  const taskId = payload.taskId || payload.id || payload.jobId || randomUUID();
  const tenantId = payload.tenantId || "tenant_01";
  const command = payload.command || payload.text || "Validate employee timesheet and policy compliance";
  const rawTimesheetText = payload.rawTimesheetText || payload.timesheet || payload.text || command;

  console.log(`[Taskmaster Subscriber] Ingested message for Task ID: ${taskId} on topic: ${PUBSUB_TOPIC}`);

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
    rawTimesheetText,
    auditLogs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  tasksStore.set(taskId, task);
  await createJob(taskId, command, tenantId);
  await updateJobStatus(taskId, "running");

  try {
    // Step 1: Process unstructured timesheet text using Google Gemini API
    console.log(`[Taskmaster Subscriber] Processing timesheet text with Gemini API for Task: ${taskId}...`);
    auditLogs.push({
      timestamp: new Date().toISOString(),
      stage: "gemini_parsing",
      actor: "gemini_agent",
      message: "Transforming unstructured shift text into structured timesheet JSON data via Gemini 2.5 Flash",
    });

    const structuredTimesheet = await processUnstructuredTimesheet(rawTimesheetText);
    task.structuredTimesheet = structuredTimesheet;
    task.employeeId = structuredTimesheet.employeeId;

    // Step 2: Retrieve employee record from Firestore
    let employeeRecord: EmployeeRecord | null = null;
    if (structuredTimesheet.employeeId && structuredTimesheet.employeeId !== "emp_unknown") {
      const empSnap = await employeesCol.doc(structuredTimesheet.employeeId).get();
      if (empSnap.exists) {
        employeeRecord = empSnap.data();
      }
    }

    // Step 3: Run HR Policy & Labor Regulation Auditing via validator
    auditLogs.push({
      timestamp: new Date().toISOString(),
      stage: "policy_validation",
      actor: "system",
      message: "Validating extracted timesheet metrics against corporate labor compliance rules",
    });

    const { report, auditResults } = await validateTaskPolicies(
      structuredTimesheet,
      employeeRecord,
    );

    task.validationReport = report;
    task.policyAuditResults = auditResults;
    task.requiresHumanReview = report.requiresHumanReview;
    task.updatedAt = new Date().toISOString();

    // Step 4: Routing & Notification handling based on validation outcome
    if (report.requiresHumanReview) {
      task.status = "needs_review";
      const violations = auditResults.filter((r) => !r.passed);
      const violationSummary = violations.map((r) => r.violationMessage).join("; ");

      auditLogs.push({
        timestamp: new Date().toISOString(),
        stage: "hitl_interrupt",
        actor: "system",
        message: `Execution paused for Human-in-the-Loop review. Violations: ${violationSummary}`,
        details: { violations },
      });

      // Trigger notification & status update for supervisor
      const notification = triggerHumanReviewNotification(task, violations);

      await updateJobStatus(taskId, "needs_review", {
        message: `Policy Review Required: ${violationSummary}`,
        structuredTimesheet,
        validationReport: report,
        notificationId: notification.id,
      });

      console.log(`[Taskmaster Subscriber] Task ${taskId} flagged for human approval. Notification ${notification.id} dispatched.`);
    } else {
      task.status = "completed";
      task.completedAt = new Date().toISOString();

      auditLogs.push({
        timestamp: new Date().toISOString(),
        stage: "completion",
        actor: "system",
        message: "Timesheet validated successfully with 0 policy violations.",
      });

      // Update employee record hours in Firestore if employee exists
      if (employeeRecord && structuredTimesheet.employeeId) {
        await employeesCol.doc(structuredTimesheet.employeeId).update({
          regularHours: structuredTimesheet.regularHours,
          overtimeHours: structuredTimesheet.overtimeHours,
        });
      }

      await updateJobStatus(taskId, "completed", {
        result: `Timesheet approved. Regular: ${structuredTimesheet.regularHours}h, Overtime: ${structuredTimesheet.overtimeHours}h. Total: ${structuredTimesheet.totalHours}h. All compliance checks passed.`,
        structuredTimesheet,
        validationReport: report,
      });

      console.log(`[Taskmaster Subscriber] Task ${taskId} completed successfully.`);
    }

    // Step 5: Index validated task data into Meilisearch for searchable audit history
    try {
      await indexValidatedTask(task);
    } catch (meiliErr: any) {
      console.warn(`[Taskmaster Subscriber] Audit indexing skipped (${meiliErr?.message}).`);
    }

    tasksStore.set(taskId, task);

    if (typeof ack === "function") {
      ack();
    }
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    console.error(`[Taskmaster Subscriber] Error processing task ${taskId}:`, errorMsg);

    task.status = "failed";
    task.updatedAt = new Date().toISOString();
    task.auditLogs.push({
      timestamp: new Date().toISOString(),
      stage: "completion",
      actor: "system",
      message: `Processing failed with error: ${errorMsg}`,
    });

    await updateJobStatus(taskId, "error", { message: errorMsg });

    // Index failed task in Meilisearch as well for complete audit logs
    try {
      await indexValidatedTask(task);
    } catch {}

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
  notificationsStore,
  tasksStore,
};
