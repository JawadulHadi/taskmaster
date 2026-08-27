/**
 * Shared in-memory stores + notification helper used by the API layer.
 *
 * NOTE: this file previously also contained `AgenticWorkflowEngine` — a
 * second, fully separate job-processing pipeline (hardcoded EventEmitter
 * chain, one Gemini call, four hardcoded validator calls in fixed order,
 * no model decision-making anywhere in it) that ran IN PARALLEL with the
 * real Genkit agent (`taskmasterFlow` in server.ts) on every job submitted
 * via `POST /jobs`. Both pipelines wrote to the same Firestore job doc
 * concurrently — a race condition, not a style issue. It's been removed.
 * `taskmasterFlow` is now the single execution path. See ADR-01.
 */
import { randomUUID } from "node:crypto";

export interface HumanReviewNotification {
  id: string;
  taskId: string;
  employeeId?: string;
  type: "overtime_approval_required" | "policy_violation_alert";
  title: string;
  message: string;
  severity: "high" | "critical" | "medium";
  timestamp: string;
  status: "unread" | "acknowledged" | "resolved";
  actionUrl?: string;
}

// In-memory store for supervisor review notifications (UI-facing only —
// job state of record lives in Firestore, see lib/firestore.ts)
export const notificationsStore: HumanReviewNotification[] = [];

type NotificationListener = (notification: HumanReviewNotification) => void;
const notificationListeners: NotificationListener[] = [];

export function onHumanReviewNotification(listener: NotificationListener) {
  notificationListeners.push(listener);
}

/**
 * Pushes a Human-in-the-Loop review notification for the supervisor UI.
 * Called directly from server.ts's `executeWorkerTask` when the Genkit
 * flow returns `finishReason: "interrupted"` — i.e. driven by the real
 * agent's actual interrupt, not a hardcoded policy check.
 */
export function pushHumanReviewNotification(params: {
  taskId: string;
  employeeId?: string;
  message: string;
  severity?: "high" | "critical" | "medium";
}): HumanReviewNotification {
  const notification: HumanReviewNotification = {
    id: `notif_${randomUUID()}`,
    taskId: params.taskId,
    employeeId: params.employeeId,
    type: "overtime_approval_required",
    title: `⚠️ Review Required: ${params.employeeId ?? params.taskId}`,
    message: params.message,
    severity: params.severity ?? "high",
    timestamp: new Date().toISOString(),
    status: "unread",
    actionUrl: `/?taskId=${params.taskId}`,
  };

  notificationsStore.unshift(notification);
  for (const listener of notificationListeners) {
    try {
      listener(notification);
    } catch (err) {
      console.error("[Notification] listener error:", err);
    }
  }

  return notification;
}
