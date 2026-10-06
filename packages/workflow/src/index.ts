import type { TaskStatus } from "@company/contracts";
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 409,
    message = code,
  ) {
    super(message);
  }
}
export type Action =
  | "PLAN"
  | "RETRY"
  | "CLAIM"
  | "COMPLETE"
  | "APPROVE"
  | "CHANGES"
  | "REJECT"
  | "FAIL"
  | "CANCEL";
const transitions: Record<Action, Partial<Record<TaskStatus, TaskStatus>>> = {
  PLAN: { DRAFT: "QUEUED_FOR_PLANNING" },
  RETRY: { FAILED: "QUEUED_FOR_PLANNING" },
  CLAIM: { QUEUED_FOR_PLANNING: "PLANNING", PLANNING: "PLANNING" },
  COMPLETE: { PLANNING: "WAITING_PLAN_APPROVAL" },
  APPROVE: { WAITING_PLAN_APPROVAL: "PLAN_APPROVED" },
  CHANGES: { WAITING_PLAN_APPROVAL: "QUEUED_FOR_PLANNING" },
  REJECT: { WAITING_PLAN_APPROVAL: "REJECTED" },
  FAIL: { PLANNING: "FAILED", QUEUED_FOR_PLANNING: "FAILED" },
  CANCEL: {
    DRAFT: "CANCELLED",
    QUEUED_FOR_PLANNING: "CANCELLED",
    PLANNING: "CANCELLED",
    WAITING_PLAN_APPROVAL: "CANCELLED",
    FAILED: "CANCELLED",
  },
};
export function transition(status: string, action: Action): TaskStatus {
  const result = transitions[action][status as TaskStatus];
  if (!result)
    throw new DomainError(
      "INVALID_TRANSITION",
      409,
      `Cannot ${action.toLowerCase()} a task in ${status}.`,
    );
  return result;
}
export function checkApproval(
  task: { status: string; version: number; currentPlanId: string | null },
  planId: string,
  version: number,
) {
  if (
    task.status !== "WAITING_PLAN_APPROVAL" ||
    task.version !== version ||
    task.currentPlanId !== planId
  )
    throw new DomainError(
      "STALE_APPROVAL",
      409,
      "This task or plan changed. Refresh and review the current plan before deciding.",
    );
}
export const terminal = new Set(["PLAN_APPROVED", "REJECTED", "CANCELLED"]);
export function backoff(attempt: number, random = Math.random()) {
  return Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(random * 500);
}
