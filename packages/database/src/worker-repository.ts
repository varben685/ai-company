import { randomUUID } from "node:crypto";
import {
  BusinessPlanSchema,
  ProductInput,
  type JobPayload,
} from "@company/contracts";
import { transition, backoff } from "@company/workflow";
import { estimate, type Pricing } from "@company/observability";
import type {
  AgentExecution,
  ExecutionMetadata,
  ProviderError,
} from "@company/agents";
import { event, json, PlatformRepository, type Tx } from "./index";
export interface Claim {
  payload: JobPayload;
  token: string;
  attemptId: string;
  input: ReturnType<typeof ProductInput.parse>;
  provider: string;
  model: string | null;
}
export class WorkerRepository {
  constructor(
    readonly repository: PlatformRepository,
    readonly leaseMs = 30000,
    readonly pricing: Pricing | null = null,
  ) {}
  get db() {
    return this.repository.db;
  }
  async claim(payload: JobPayload): Promise<Claim | null> {
    return this.repository.transaction(async (tx) => {
      const t = await this.repository.task(tx, payload.taskId);
      if (
        t.projectId !== payload.projectId ||
        t.activeRunId !== payload.agentRunId ||
        !["QUEUED_FOR_PLANNING", "PLANNING"].includes(t.status)
      )
        return null;
      const r = await tx.agentRun.findFirst({
        where: { id: payload.agentRunId, taskId: t.id, projectId: t.projectId },
      });
      if (
        !r ||
        !["QUEUED", "RUNNING"].includes(r.status) ||
        r.nextAttemptAt > new Date() ||
        (r.ownerToken && r.leaseUntil && r.leaseUntil > new Date())
      )
        return null;
      await tx.agentRunAttempt.updateMany({
        where: { agentRunId: r.id, status: "RUNNING" },
        data: {
          status: "INTERRUPTED",
          finishedAt: new Date(),
          errorCode: "LEASE_EXPIRED",
        },
      });
      if (r.attemptCount >= 3) {
        await this.fail(tx, t, r.id, "ATTEMPT_LIMIT");
        return null;
      }
      const token = randomUUID();
      const now = new Date();
      await tx.agentRun.update({
        where: { id: r.id },
        data: {
          status: "RUNNING",
          ownerToken: token,
          leaseUntil: new Date(now.getTime() + this.leaseMs),
          startedAt: r.startedAt ?? now,
          attemptCount: { increment: 1 },
        },
      });
      const attempt = await tx.agentRunAttempt.create({
        data: {
          projectId: t.projectId,
          agentRunId: r.id,
          attemptNumber: r.attemptCount + 1,
          ownerToken: token,
          status: "RUNNING",
          ...(r.provider === "DEMO"
            ? { estimatedCostUsd: "0", pricingVersion: "demo-v1" }
            : {}),
        },
      });
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, "CLAIM"),
          version: { increment: 1 },
        },
      });
      await event(tx, t, "ATTEMPT_STARTED", r.id, null, r.id, {
        attemptNumber: r.attemptCount + 1,
      });
      return {
        payload,
        token,
        attemptId: attempt.id,
        input: ProductInput.parse(r.inputSnapshot),
        provider: r.provider,
        model: r.model,
      };
    });
  }
  async heartbeat(c: Claim) {
    const result = await this.db.agentRun.updateMany({
      where: {
        id: c.payload.agentRunId,
        ownerToken: c.token,
        status: "RUNNING",
        leaseUntil: { gt: new Date() },
      },
      data: { leaseUntil: new Date(Date.now() + this.leaseMs) },
    });
    return result.count === 1;
  }
  async owned(tx: Tx, c: Claim) {
    const t = await this.repository.task(tx, c.payload.taskId);
    const r = await tx.agentRun.findUniqueOrThrow({
      where: { id: c.payload.agentRunId },
    });
    return {
      t,
      r,
      valid:
        t.projectId === c.payload.projectId &&
        t.activeRunId === r.id &&
        t.status === "PLANNING" &&
        r.status === "RUNNING" &&
        r.ownerToken === c.token &&
        !!r.leaseUntil &&
        r.leaseUntil > new Date(),
    };
  }
  async accounting(tx: Tx, c: Claim, m: ExecutionMetadata) {
    const cost = estimate(m.provider, m.model, m.usage, this.pricing);
    await tx.agentRunAttempt.updateMany({
      where: { id: c.attemptId, ownerToken: c.token },
      data: {
        ...(m.usage.inputTokens !== null
          ? { inputTokens: m.usage.inputTokens }
          : {}),
        ...(m.usage.outputTokens !== null
          ? { outputTokens: m.usage.outputTokens }
          : {}),
        ...(m.usage.cachedInputTokens !== null
          ? { cachedInputTokens: m.usage.cachedInputTokens }
          : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.providerRequestId
          ? { providerRequestId: m.providerRequestId }
          : {}),
        ...(cost !== null
          ? {
              estimatedCostUsd: cost,
              pricingVersion:
                m.provider === "DEMO" ? "demo-v1" : this.pricing?.version,
            }
          : {}),
      },
    });
  }
  async complete(c: Claim, result: AgentExecution<unknown>) {
    const plan = BusinessPlanSchema.parse(result.output);
    return this.repository.transaction(async (tx) => {
      const { t, r, valid } = await this.owned(tx, c);
      await this.accounting(tx, c, result);
      if (!valid) {
        await tx.agentRunAttempt.updateMany({
          where: { id: c.attemptId, ownerToken: c.token, status: "RUNNING" },
          data: {
            status: t.status === "CANCELLED" ? "CANCELLED" : "INTERRUPTED",
            finishedAt: new Date(),
            errorCode: "STALE_RESULT",
          },
        });
        return false;
      }
      const count = await tx.taskPlan.count({ where: { taskId: t.id } });
      const p = await tx.taskPlan.create({
        data: {
          taskId: t.id,
          projectId: t.projectId,
          versionNumber: count + 1,
          agentRunId: r.id,
          schemaVersion: "1",
          content: json(plan),
          contextVersion: c.input.project.contextVersion,
        },
      });
      await tx.approval.create({
        data: { taskId: t.id, projectId: t.projectId, targetPlanId: p.id },
      });
      await tx.agentRunAttempt.update({
        where: { id: c.attemptId },
        data: { status: "SUCCEEDED", finishedAt: new Date() },
      });
      const finalized = await tx.agentRun.updateMany({
        where: {
          id: r.id,
          status: "RUNNING",
          ownerToken: c.token,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: "SUCCEEDED",
          outputPlanId: p.id,
          model: result.model,
          finishedAt: new Date(),
          ownerToken: null,
          leaseUntil: null,
        },
      });
      if (finalized.count !== 1)
        throw new Error("LEASE_LOST_DURING_FINALIZATION");
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, "COMPLETE"),
          version: { increment: 1 },
          currentPlanId: p.id,
          activeRunId: null,
          failureCode: null,
        },
      });
      await event(tx, t, "PLAN_CREATED", r.id, null, r.id, {
        planId: p.id,
        versionNumber: p.versionNumber,
      });
      return true;
    });
  }
  private async fail(
    tx: Tx,
    t: { id: string; projectId: string; status: string },
    runId: string,
    code: string,
    claim?: Claim,
  ) {
    const finalized = await tx.agentRun.updateMany({
      where: {
        id: runId,
        status: { in: ["QUEUED", "RUNNING"] },
        ...(claim
          ? { ownerToken: claim.token, leaseUntil: { gt: new Date() } }
          : {}),
      },
      data: {
        status: "FAILED",
        failureCode: code,
        finishedAt: new Date(),
        ownerToken: null,
        leaseUntil: null,
      },
    });
    if (finalized.count !== 1)
      throw new Error("LEASE_LOST_DURING_FINALIZATION");
    await tx.task.update({
      where: { id: t.id },
      data: {
        status: transition(t.status, "FAIL"),
        version: { increment: 1 },
        activeRunId: null,
        failureCode: code,
      },
    });
    await event(tx, t, "PLANNING_FAILED", runId, null, runId, { code });
  }
  async failure(c: Claim, error: ProviderError) {
    return this.repository.transaction(async (tx) => {
      const { t, r, valid } = await this.owned(tx, c);
      await this.accounting(tx, c, error.metadata);
      if (!valid) {
        await tx.agentRunAttempt.updateMany({
          where: { id: c.attemptId, status: "RUNNING" },
          data: {
            status: t.status === "CANCELLED" ? "CANCELLED" : "INTERRUPTED",
            finishedAt: new Date(),
            errorCode: "STALE_RESULT",
          },
        });
        return;
      }
      await tx.agentRunAttempt.update({
        where: { id: c.attemptId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorCode: error.code,
        },
      });
      if (!error.retryable || r.attemptCount >= 3) {
        await this.fail(tx, t, r.id, error.code, c);
        return;
      }
      const nextAttemptAt = new Date(Date.now() + backoff(r.attemptCount));
      const scheduled = await tx.agentRun.updateMany({
        where: {
          id: r.id,
          status: "RUNNING",
          ownerToken: c.token,
          leaseUntil: { gt: new Date() },
        },
        data: { ownerToken: null, leaseUntil: null, nextAttemptAt },
      });
      if (scheduled.count !== 1)
        throw new Error("LEASE_LOST_DURING_FINALIZATION");
      await event(tx, t, "ATTEMPT_RETRY_SCHEDULED", r.id, null, r.id, {
        code: error.code,
        attemptNumber: r.attemptCount,
      });
    });
  }
  pending() {
    return this.db.outboxMessage.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
      take: 100,
      orderBy: { createdAt: "asc" },
      include: { run: { include: { task: true } } },
    });
  }
  recoverable() {
    return this.db.agentRun.findMany({
      where: {
        status: { in: ["QUEUED", "RUNNING"] },
        outbox: { some: { status: "DISPATCHED" } },
        nextAttemptAt: { lte: new Date() },
        OR: [{ ownerToken: null }, { leaseUntil: { lte: new Date() } }],
      },
      include: { task: true },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
  }
}
