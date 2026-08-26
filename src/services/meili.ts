import { Meilisearch } from "meilisearch";
import { Task, StructuredTimesheet, HRValidationReport } from "../models/task.js";

export interface TaskAuditDocument {
  id: string;
  taskId: string;
  jobId: string;
  tenantId: string;
  employeeId: string;
  employeeName?: string;
  department?: string;
  status: string;
  type: string;
  command: string;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  workDays: number;
  requiresHumanReview: boolean;
  humanDecision?: string;
  supervisorNotes?: string;
  validationStatus: "valid" | "flagged" | "rejected";
  totalViolations: number;
  violatedRules: string[];
  violationMessages: string[];
  recommendedAction: string;
  auditSummary: string;
  rawTimesheetText?: string;
  createdAt: string;
  completedAt?: string;
  searchableContent: string;
}

const AUDIT_INDEX_NAME = "task_audit_history";

// In-memory store fallback for task audit history
const inMemoryAuditStore: Map<string, TaskAuditDocument> = new Map();

let meiliClient: Meilisearch | null = null;
let meiliAvailable = false;
let meiliChecked = false;

const host = process.env.MEILI_HOST || process.env.MEILI_URL;

if (host && !host.includes("localhost:7700")) {
  try {
    meiliClient = new Meilisearch({
      host,
      apiKey: process.env.MEILI_API_KEY,
    });
    meiliAvailable = true;
  } catch (err) {
    meiliAvailable = false;
  }
}

/**
 * Returns the Meilisearch client or null if unconfigured.
 */
export function getMeiliClient(): Meilisearch | null {
  return meiliAvailable ? meiliClient : null;
}

/**
 * Transforms a Task entity into a searchable audit document.
 */
export function formatTaskForAuditIndex(task: Task): TaskAuditDocument {
  const timesheet = task.structuredTimesheet;
  const report = task.validationReport;
  const violations = report?.policyResults?.filter((r) => !r.passed) || [];

  const employeeId = task.employeeId || timesheet?.employeeId || "emp_unknown";
  const employeeName = timesheet?.employeeName || "";
  const department = timesheet?.department || "General";
  const totalHours = timesheet?.totalHours ?? 0;
  const regularHours = timesheet?.regularHours ?? 0;
  const overtimeHours = timesheet?.overtimeHours ?? 0;
  const workDays = timesheet?.workDays ?? 0;
  const totalViolations = report?.totalViolations ?? violations.length;
  const violatedRules = violations.map((v) => v.ruleCode);
  const violationMessages = violations.map((v) => v.violationMessage || v.policyTitle);

  let validationStatus: "valid" | "flagged" | "rejected" = "valid";
  if (report?.recommendedAction === "reject" || task.status === "rejected") {
    validationStatus = "rejected";
  } else if (task.requiresHumanReview || totalViolations > 0 || task.status === "needs_review") {
    validationStatus = "flagged";
  }

  const auditSummary =
    report?.summary ||
    (totalViolations > 0
      ? `${totalViolations} compliance violation(s) identified.`
      : "Passed all HR policy checks.");

  const searchableContent = [
    task.id,
    task.command,
    employeeId,
    employeeName,
    department,
    task.status,
    task.rawTimesheetText || "",
    auditSummary,
    ...violatedRules,
    ...violationMessages,
    task.supervisorNotes || "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: task.id,
    taskId: task.id,
    jobId: task.jobId || task.id,
    tenantId: task.tenantId || "tenant_01",
    employeeId,
    employeeName,
    department,
    status: task.status,
    type: task.type,
    command: task.command,
    totalHours,
    regularHours,
    overtimeHours,
    workDays,
    requiresHumanReview: Boolean(task.requiresHumanReview),
    humanDecision: task.humanDecision,
    supervisorNotes: task.supervisorNotes,
    validationStatus,
    totalViolations,
    violatedRules,
    violationMessages,
    recommendedAction: report?.recommendedAction || "auto_approve",
    auditSummary,
    rawTimesheetText: task.rawTimesheetText,
    createdAt: task.createdAt || new Date().toISOString(),
    completedAt: task.completedAt,
    searchableContent,
  };
}

/**
 * Indexes a validated Task into Meilisearch for audit trails and compliance discovery.
 */
export async function indexValidatedTask(task: Task): Promise<{ success: boolean; id: string }> {
  const auditDoc = formatTaskForAuditIndex(task);

  // Always save to memory store for guaranteed fast local access
  inMemoryAuditStore.set(auditDoc.id, auditDoc);

  if (meiliAvailable && meiliClient) {
    try {
      const index = meiliClient.index<TaskAuditDocument>(AUDIT_INDEX_NAME);
      await index.addDocuments([auditDoc]);
      return { success: true, id: task.id };
    } catch (err: any) {
      meiliAvailable = false;
    }
  }

  return { success: true, id: task.id };
}

/**
 * Searches the audit history by query string with optional tenant and limit filters.
 */
export async function searchAuditHistory(
  query: string,
  options: {
    limit?: number;
    tenantId?: string;
    status?: string;
    employeeId?: string;
  } = {},
) {
  const limit = options.limit ?? 20;

  if (meiliAvailable && meiliClient) {
    try {
      const index = meiliClient.index<TaskAuditDocument>(AUDIT_INDEX_NAME);
      const filterConditions: string[] = [];
      if (options.tenantId) filterConditions.push(`tenantId = "${options.tenantId}"`);
      if (options.status) filterConditions.push(`status = "${options.status}"`);
      if (options.employeeId) filterConditions.push(`employeeId = "${options.employeeId}"`);

      const searchRes = await index.search(query, {
        limit,
        filter: filterConditions.length > 0 ? filterConditions.join(" AND ") : undefined,
      });

      const totalHits =
        (searchRes as any).estimatedTotalHits ??
        (searchRes as any).totalHits ??
        searchRes.hits.length;

      return {
        hits: searchRes.hits,
        query,
        totalHits,
        source: "meilisearch_cluster",
      };
    } catch (err: any) {
      meiliAvailable = false;
    }
  }

  // Resilient in-memory search fallback
  const q = (query || "").toLowerCase().trim();
  const allDocs = Array.from(inMemoryAuditStore.values());

  const matched = allDocs.filter((doc) => {
    if (options.tenantId && doc.tenantId !== options.tenantId) return false;
    if (options.status && doc.status !== options.status) return false;
    if (options.employeeId && doc.employeeId !== options.employeeId) return false;

    if (!q) return true;

    return (
      doc.id.toLowerCase().includes(q) ||
      doc.employeeId.toLowerCase().includes(q) ||
      (doc.employeeName && doc.employeeName.toLowerCase().includes(q)) ||
      doc.department?.toLowerCase().includes(q) ||
      doc.command.toLowerCase().includes(q) ||
      doc.status.toLowerCase().includes(q) ||
      doc.auditSummary.toLowerCase().includes(q) ||
      doc.violatedRules.some((r) => r.toLowerCase().includes(q)) ||
      doc.searchableContent.toLowerCase().includes(q)
    );
  });

  // Sort descending by creation date
  matched.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    hits: matched.slice(0, limit),
    query,
    totalHits: matched.length,
    source: "in_memory_audit_index",
  };
}

/**
 * Returns all indexed audit records.
 */
export async function getAuditHistory(options: { limit?: number; tenantId?: string } = {}) {
  return searchAuditHistory("", options);
}

/**
 * Re-indexes a list of tasks.
 */
export async function reindexAllTasks(tasks: Task[]) {
  for (const task of tasks) {
    await indexValidatedTask(task);
  }
  return { count: tasks.length };
}

export default {
  indexValidatedTask,
  searchAuditHistory,
  getAuditHistory,
  formatTaskForAuditIndex,
  reindexAllTasks,
};
