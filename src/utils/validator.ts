import {
  Task,
  StructuredTimesheet,
  PolicyAuditResult,
  HRValidationReport,
  TimesheetEntry,
} from "../models/task.js";
import { EmployeeRecord } from "../lib/firestore.js";
import { policyIndex, PolicyDocument } from "../lib/meili.js";

export interface ValidationOptions {
  overtimeApprovalLimit?: number;
  weeklyMaxHoursLimit?: number;
  consecutiveWorkdaysLimit?: number;
  dailyMaxHoursLimit?: number;
  mandatoryRestBreakHours?: number;
}

export const DEFAULT_HR_POLICIES = {
  DAILY_MAX_HOURS: 12.0,
  WEEKLY_MAX_HOURS: 60.0,
  OVERTIME_APPROVAL_CEILING: 10.0,
  CONSECUTIVE_WORKDAYS: 6.0,
  MANDATORY_REST_HOURS: 11.0,
};

/**
 * Checks if daily working hours exceed regulatory health and safety thresholds.
 */
export function checkDailyHoursLimit(
  entries: TimesheetEntry[] = [],
  dailyLimit = DEFAULT_HR_POLICIES.DAILY_MAX_HOURS,
): PolicyAuditResult {
  const violatingDays = entries.filter((e) => e.hoursWorked > dailyLimit);
  const maxDayHours = entries.reduce((max, e) => Math.max(max, e.hoursWorked), 0);
  const passed = violatingDays.length === 0;

  return {
    policyId: "pol_daily_limit",
    ruleCode: "daily_shift_max_hours",
    policyTitle: "Maximum Daily Shift Duration",
    severity: "high",
    thresholdLimit: dailyLimit,
    actualValue: Number(maxDayHours.toFixed(1)),
    unit: "hours/day",
    passed,
    violationMessage: passed
      ? undefined
      : `Daily shift duration (${maxDayHours}h) exceeds the regulatory limit of ${dailyLimit}h/day on ${violatingDays.map((d) => d.dayOfWeek || d.date).join(", ")}.`,
    requiresSupervisorApproval: !passed,
  };
}

/**
 * Checks if overtime hours exceed corporate approval thresholds without prior manager authorization.
 */
export function checkOvertimeCeiling(
  timesheet: StructuredTimesheet,
  isPreApproved: boolean,
  ceiling = DEFAULT_HR_POLICIES.OVERTIME_APPROVAL_CEILING,
): PolicyAuditResult {
  const isOvertimeExceeded = timesheet.overtimeHours > ceiling;
  const passed = !isOvertimeExceeded || isPreApproved;

  return {
    policyId: "pol_01",
    ruleCode: "overtime_approval_limit",
    policyTitle: "Overtime Approval Limit Ceiling",
    severity: "high",
    thresholdLimit: ceiling,
    actualValue: Number(timesheet.overtimeHours.toFixed(1)),
    unit: "hours",
    passed,
    violationMessage: passed
      ? undefined
      : `Unapproved overtime of ${timesheet.overtimeHours}h exceeds the corporate threshold limit of ${ceiling}h. Requires supervisor review.`,
    requiresSupervisorApproval: !passed,
  };
}

/**
 * Checks weekly cumulative hours against labor law fatigue and maximum working hour caps.
 */
export function checkWeeklyMaxHours(
  timesheet: StructuredTimesheet,
  weeklyMax = DEFAULT_HR_POLICIES.WEEKLY_MAX_HOURS,
): PolicyAuditResult {
  const passed = timesheet.totalHours <= weeklyMax;

  return {
    policyId: "pol_02",
    ruleCode: "weekly_max_hours",
    policyTitle: "Maximum Weekly Working Hours (Labor Safety Cap)",
    severity: "critical",
    thresholdLimit: weeklyMax,
    actualValue: Number(timesheet.totalHours.toFixed(1)),
    unit: "hours/week",
    passed,
    violationMessage: passed
      ? undefined
      : `Total weekly hours (${timesheet.totalHours}h) violate mandatory fatigue threshold of ${weeklyMax}h/week.`,
    requiresSupervisorApproval: !passed,
  };
}

/**
 * Checks consecutive work days to ensure mandatory weekly rest periods.
 */
export function checkConsecutiveWorkdays(
  timesheet: StructuredTimesheet,
  maxDays = DEFAULT_HR_POLICIES.CONSECUTIVE_WORKDAYS,
): PolicyAuditResult {
  const workDaysCount = timesheet.workDays || timesheet.entries?.length || 5;
  const passed = workDaysCount <= maxDays;

  return {
    policyId: "pol_03",
    ruleCode: "consecutive_workdays_limit",
    policyTitle: "Consecutive Workdays Limit (Mandatory Rest)",
    severity: "high",
    thresholdLimit: maxDays,
    actualValue: workDaysCount,
    unit: "days",
    passed,
    violationMessage: passed
      ? undefined
      : `Consecutive workdays (${workDaysCount} days) exceed statutory maximum of ${maxDays} consecutive days without rest.`,
    requiresSupervisorApproval: !passed,
  };
}

/**
 * Validates a Task object or structured timesheet against all HR labor policies and regulations.
 */
export async function validateTaskPolicies(
  taskOrTimesheet: Task | StructuredTimesheet,
  employeeRecord?: EmployeeRecord | null,
  options?: ValidationOptions,
): Promise<{
  report: HRValidationReport;
  auditResults: PolicyAuditResult[];
}> {
  // Extract structured timesheet from Task or use directly
  const structuredTimesheet: StructuredTimesheet =
    "structuredTimesheet" in taskOrTimesheet && taskOrTimesheet.structuredTimesheet
      ? taskOrTimesheet.structuredTimesheet
      : (taskOrTimesheet as StructuredTimesheet);

  if (!structuredTimesheet) {
    throw new Error("No structured timesheet available to validate policies.");
  }

  // Load custom configured policies from Meilisearch/Policy DB if available
  let dynamicPolicies: PolicyDocument[] = [];
  try {
    dynamicPolicies = await policyIndex.getDocuments();
  } catch (err) {
    // Fall back to defaults
  }

  const otPolicyDoc = dynamicPolicies.find((p) => p.ruleCode === "overtime_approval_limit");
  const maxHoursDoc = dynamicPolicies.find((p) => p.ruleCode === "weekly_max_hours");
  const workdaysDoc = dynamicPolicies.find((p) => p.ruleCode === "consecutive_workdays_limit");

  const otLimit = options?.overtimeApprovalLimit ?? otPolicyDoc?.thresholdLimit ?? DEFAULT_HR_POLICIES.OVERTIME_APPROVAL_CEILING;
  const weeklyLimit = options?.weeklyMaxHoursLimit ?? maxHoursDoc?.thresholdLimit ?? DEFAULT_HR_POLICIES.WEEKLY_MAX_HOURS;
  const workdaysLimit = options?.consecutiveWorkdaysLimit ?? workdaysDoc?.thresholdLimit ?? DEFAULT_HR_POLICIES.CONSECUTIVE_WORKDAYS;
  const dailyLimit = options?.dailyMaxHoursLimit ?? DEFAULT_HR_POLICIES.DAILY_MAX_HOURS;

  const isPreApproved = Boolean(employeeRecord?.overtimeApproved);

  // Run all policy evaluations
  const auditResults: PolicyAuditResult[] = [
    checkOvertimeCeiling(structuredTimesheet, isPreApproved, otLimit),
    checkWeeklyMaxHours(structuredTimesheet, weeklyLimit),
    checkConsecutiveWorkdays(structuredTimesheet, workdaysLimit),
    checkDailyHoursLimit(structuredTimesheet.entries, dailyLimit),
  ];

  // Evaluate violations
  const violations = auditResults.filter((r) => !r.passed);
  const requiresHumanReview = violations.some((v) => v.requiresSupervisorApproval);
  const criticalViolations = violations.filter((v) => v.severity === "critical");

  let recommendedAction: "auto_approve" | "require_approval" | "reject" = "auto_approve";
  if (criticalViolations.length > 0) {
    recommendedAction = "reject";
  } else if (requiresHumanReview) {
    recommendedAction = "require_approval";
  }

  const summary =
    violations.length === 0
      ? `All ${auditResults.length} HR and labor policies passed verification successfully.`
      : `${violations.length} policy violation(s) detected: ${violations.map((v) => `${v.policyTitle} (${v.actualValue} ${v.unit})`).join("; ")}.`;

  const report: HRValidationReport = {
    isValid: violations.length === 0,
    totalViolations: violations.length,
    requiresHumanReview,
    policyResults: auditResults,
    summary,
    recommendedAction,
  };

  return { report, auditResults };
}

export default {
  validateTaskPolicies,
  checkOvertimeCeiling,
  checkWeeklyMaxHours,
  checkConsecutiveWorkdays,
  checkDailyHoursLimit,
  DEFAULT_HR_POLICIES,
};
