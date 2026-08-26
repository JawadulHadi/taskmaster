/**
 * Standardized Task Model for Taskmaster HR Ops & Policy Auditing
 */

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "in_progress"
  | "needs_review"
  | "completed"
  | "failed"
  | "rejected"
  | "approved";

export type TaskType =
  | "timesheet_validation"
  | "policy_audit"
  | "overtime_review"
  | "compliance_check"
  | "general_task";

export interface TimesheetEntry {
  date: string;
  dayOfWeek?: string;
  hoursWorked: number;
  regularHours: number;
  overtimeHours: number;
  department?: string;
  notes?: string;
  tasksSummary?: string;
}

export interface StructuredTimesheet {
  employeeId: string;
  employeeName?: string;
  department?: string;
  periodStart?: string;
  periodEnd?: string;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  workDays: number;
  entries: TimesheetEntry[];
  rawText?: string;
  confidenceScore?: number;
  notes?: string;
  potentialViolations?: string[];
}

export interface PolicyAuditResult {
  policyId: string;
  ruleCode: string;
  policyTitle: string;
  severity: "low" | "medium" | "high" | "critical";
  thresholdLimit: number;
  actualValue: number;
  unit: string;
  passed: boolean;
  violationMessage?: string;
  requiresSupervisorApproval: boolean;
}

export interface AuditLogEntry {
  timestamp: string;
  stage: "ingestion" | "gemini_parsing" | "policy_validation" | "hitl_interrupt" | "resolution" | "completion";
  actor: "system" | "gemini_agent" | "human_supervisor";
  message: string;
  details?: Record<string, any>;
}

export interface HRValidationReport {
  isValid: boolean;
  totalViolations: number;
  requiresHumanReview: boolean;
  policyResults: PolicyAuditResult[];
  summary: string;
  recommendedAction: "auto_approve" | "require_approval" | "reject";
}

/**
 * Standardized Task Object Interface for Auditing and HR Policy Validation
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  
  /** Legacy alias for interoperability with job queue */
  jobId?: string;

  /** Multi-tenant tenant identifier */
  tenantId: string;

  /** Employee identifier associated with this task */
  employeeId?: string;

  /** Type/category of the HR workflow */
  type: TaskType;

  /** Current execution status */
  status: TaskStatus;

  /** Command directive or user prompt */
  command: string;

  /** Raw unstructured timesheet or shift note text */
  rawTimesheetText?: string;

  /** Structured JSON data extracted via Gemini service */
  structuredTimesheet?: StructuredTimesheet;

  /** Policy evaluation results */
  policyAuditResults?: PolicyAuditResult[];

  /** High-level HR policy compliance validation report */
  validationReport?: HRValidationReport;

  /** Flag indicating if human supervisor review is mandatory */
  requiresHumanReview?: boolean;

  /** Final decision from human manager/supervisor */
  humanDecision?: "approved" | "rejected" | "pending";

  /** Supervisor comments during review */
  supervisorNotes?: string;

  /** Chronological audit trail */
  auditLogs: AuditLogEntry[];

  /** Creation timestamp (ISO string) */
  createdAt: string;

  /** Last update timestamp (ISO string) */
  updatedAt?: string;

  /** Completion timestamp (ISO string) */
  completedAt?: string;

  /** Additional arbitrary metadata */
  metadata?: Record<string, any>;
}
