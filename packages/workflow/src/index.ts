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
  | "CANCEL"
  | "START_DEVELOPMENT"
  | "CLAIM_DEVELOPMENT"
  | "DEVELOPED"
  | "CLAIM_VALIDATION"
  | "VALIDATED"
  | "CLAIM_REVIEW"
  | "FINAL_READY"
  | "FIX_ROUND"
  | "ROUND_LIMIT"
  | "BLOCK"
  | "DONE"
  | "RETRY_DEVELOPER"
  | "RETRY_VALIDATION"
  | "RETRY_REVIEWER";
const transitions: Record<Action, Partial<Record<TaskStatus, TaskStatus>>> = {
  PLAN: { DRAFT: "QUEUED_FOR_PLANNING" },
  RETRY: { FAILED: "QUEUED_FOR_PLANNING" },
  CLAIM: { QUEUED_FOR_PLANNING: "PLANNING", PLANNING: "PLANNING" },
  COMPLETE: { PLANNING: "WAITING_PLAN_APPROVAL" },
  APPROVE: { WAITING_PLAN_APPROVAL: "PLAN_APPROVED" },
  CHANGES: { WAITING_PLAN_APPROVAL: "QUEUED_FOR_PLANNING" },
  REJECT: {
    WAITING_PLAN_APPROVAL: "REJECTED",
    WAITING_FINAL_APPROVAL: "REJECTED",
  },
  FAIL: {
    PLANNING: "FAILED",
    QUEUED_FOR_PLANNING: "FAILED",
    QUEUED_FOR_IMPLEMENTATION: "FAILED",
    IMPLEMENTING: "FAILED",
    QUEUED_FOR_VALIDATION: "FAILED",
    VALIDATING: "FAILED",
    QUEUED_FOR_REVIEW: "FAILED",
    REVIEWING: "FAILED",
  },
  START_DEVELOPMENT: { PLAN_APPROVED: "QUEUED_FOR_IMPLEMENTATION" },
  CLAIM_DEVELOPMENT: {
    QUEUED_FOR_IMPLEMENTATION: "IMPLEMENTING",
    IMPLEMENTING: "IMPLEMENTING",
  },
  DEVELOPED: { IMPLEMENTING: "QUEUED_FOR_VALIDATION" },
  CLAIM_VALIDATION: {
    QUEUED_FOR_VALIDATION: "VALIDATING",
    VALIDATING: "VALIDATING",
  },
  VALIDATED: { VALIDATING: "QUEUED_FOR_REVIEW" },
  CLAIM_REVIEW: { QUEUED_FOR_REVIEW: "REVIEWING", REVIEWING: "REVIEWING" },
  FINAL_READY: { REVIEWING: "WAITING_FINAL_APPROVAL" },
  FIX_ROUND: { REVIEWING: "QUEUED_FOR_IMPLEMENTATION" },
  ROUND_LIMIT: { REVIEWING: "HUMAN_REVIEW_REQUIRED" },
  BLOCK: { IMPLEMENTING: "BLOCKED", REVIEWING: "BLOCKED" },
  DONE: { WAITING_FINAL_APPROVAL: "DONE" },
  RETRY_DEVELOPER: { FAILED: "QUEUED_FOR_IMPLEMENTATION" },
  RETRY_VALIDATION: { FAILED: "QUEUED_FOR_VALIDATION" },
  RETRY_REVIEWER: { FAILED: "QUEUED_FOR_REVIEW" },
  CANCEL: {
    DRAFT: "CANCELLED",
    QUEUED_FOR_PLANNING: "CANCELLED",
    PLANNING: "CANCELLED",
    WAITING_PLAN_APPROVAL: "CANCELLED",
    FAILED: "CANCELLED",
    QUEUED_FOR_IMPLEMENTATION: "CANCELLED",
    IMPLEMENTING: "CANCELLED",
    QUEUED_FOR_VALIDATION: "CANCELLED",
    VALIDATING: "CANCELLED",
    QUEUED_FOR_REVIEW: "CANCELLED",
    REVIEWING: "CANCELLED",
    WAITING_FINAL_APPROVAL: "CANCELLED",
    HUMAN_REVIEW_REQUIRED: "CANCELLED",
    BLOCKED: "CANCELLED",
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
export const terminal = new Set([
  "HUMAN_REVIEW_REQUIRED",
  "BLOCKED",
  "DONE",
  "REJECTED",
  "CANCELLED",
]);
export function requiredValidationPass(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const report = value as { status?: unknown; checks?: unknown };
  if (
    report.status !== "PASS" ||
    !Array.isArray(report.checks) ||
    report.checks.length !== 3
  )
    return false;
  const checks = report.checks as unknown[];
  const expected = ["regression", "acceptance", "syntax"];
  return expected.every((id) => {
    const matches = checks.filter(
      (x: unknown) =>
        !!x &&
        typeof x === "object" &&
        (x as { commandId?: unknown }).commandId === id,
    );
    if (matches.length !== 1) return false;
    const check = matches[0] as {
      exitCode?: unknown;
      timedOut?: unknown;
      output?: unknown;
    };
    return (
      check.exitCode === 0 &&
      check.timedOut === false &&
      (id === "syntax" ||
        (typeof check.output === "string" &&
          /\btests?\s+[1-9]\d*\b/i.test(check.output)))
    );
  });
}
export function backoff(attempt: number, random = Math.random()) {
  return Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(random * 500);
}
