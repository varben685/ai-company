import { randomUUID } from "node:crypto";
import {
  BusinessDeveloperResult,
  BusinessReviewReport,
  type JobPayload,
} from "@company/contracts";
import { backoff, transition, requiredValidationPass } from "@company/workflow";
import {
  ArtifactStore,
  workspaceContainerName,
  type CandidateDraft,
} from "@company/workspace";
import type {
  AgentExecution,
  ProviderError,
  ModelCallEvent,
} from "@company/agents";
import { estimate, pricingForModel } from "@company/observability";
import { event, json, type PlatformRepository, type Tx } from "./index";
import { M2Repository, FinalTarget } from "./m2-repository";

export type Stage = "DEVELOPER" | "REVIEWER";
export type StageClaim = {
  payload: JobPayload;
  token: string;
  attemptId: string;
  agentType: Stage;
  sessionId: string;
  round: number;
  input: Record<string, unknown>;
  provider: string;
  model: string | null;
};
export type ValidationPayload = {
  projectId: string;
  taskId: string;
  validationRunId: string;
};
export type ValidationClaim = {
  payload: ValidationPayload;
  token: string;
  sessionId: string;
  round: number;
  candidateArtifactId: string;
  candidateHash: string;
  validatorVersion: string;
};
type Stored = { hash: string; byteSize: number; storageKey: string };

export class M2WorkerRepository {
  readonly m2: M2Repository;
  readonly store: ArtifactStore;
  constructor(
    readonly repo: PlatformRepository,
    readonly leaseMs = 30000,
    store = new ArtifactStore(),
    models?: { developer: string; reviewer: string },
  ) {
    this.store = store;
    this.m2 = new M2Repository(repo, store, models);
  }
  get db() {
    return this.repo.db;
  }
  async claimAgent(
    payload: JobPayload,
    agentType: Stage,
  ): Promise<StageClaim | null> {
    return this.repo.transaction(async (tx) => {
      const t = await this.repo.task(tx, payload.taskId);
      const queued =
        agentType === "DEVELOPER"
          ? "QUEUED_FOR_IMPLEMENTATION"
          : "QUEUED_FOR_REVIEW";
      const running = agentType === "DEVELOPER" ? "IMPLEMENTING" : "REVIEWING";
      if (
        t.projectId !== payload.projectId ||
        t.activeRunId !== payload.agentRunId ||
        ![queued, running].includes(t.status)
      )
        return null;
      const r = await tx.agentRun.findFirst({
        where: {
          id: payload.agentRunId,
          taskId: t.id,
          projectId: t.projectId,
          agentType,
        },
      });
      if (
        !r ||
        !r.sessionId ||
        !r.round ||
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
      await tx.workspaceInstance.updateMany({
        where: { runId: r.id, status: { in: ["PREPARING", "ACTIVE"] } },
        data: { status: "CLEANUP_PENDING", stoppedAt: new Date() },
      });
      if (r.attemptCount >= 3) {
        await this.failRun(tx, t, r.id, agentType, "ATTEMPT_LIMIT");
        return null;
      }
      const token = randomUUID(),
        now = new Date();
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
          agentRunId: r.id,
          projectId: t.projectId,
          attemptNumber: r.attemptCount + 1,
          ownerToken: token,
          status: "RUNNING",
          ...(r.provider === "DEMO"
            ? { estimatedCostUsd: "0", pricingVersion: "demo-v1" }
            : {}),
        },
      });
      if (agentType === "DEVELOPER")
        await tx.workspaceInstance.create({
          data: {
            projectId: t.projectId,
            taskId: t.id,
            sessionId: r.sessionId,
            runId: r.id,
            attemptId: attempt.id,
            ownerToken: token,
            workdirKey: attempt.id,
            containerId: workspaceContainerName(attempt.id),
            status: "PREPARING",
          },
        });
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(
            t.status,
            agentType === "DEVELOPER" ? "CLAIM_DEVELOPMENT" : "CLAIM_REVIEW",
          ),
          version: { increment: 1 },
        },
      });
      await event(tx, t, "ATTEMPT_STARTED", r.id, null, r.id, {
        agentType,
        round: r.round,
        attemptNumber: r.attemptCount + 1,
      });
      return {
        payload,
        token,
        attemptId: attempt.id,
        agentType,
        sessionId: r.sessionId,
        round: r.round,
        input: r.inputSnapshot as Record<string, unknown>,
        provider: r.provider,
        model: r.model,
      };
    });
  }
  async heartbeatAgent(c: StageClaim) {
    const r = await this.db.agentRun.updateMany({
      where: {
        id: c.payload.agentRunId,
        ownerToken: c.token,
        status: "RUNNING",
        leaseUntil: { gt: new Date() },
      },
      data: { leaseUntil: new Date(Date.now() + this.leaseMs) },
    });
    return r.count === 1;
  }
  async modelCallStart(c: StageClaim, sequence: number) {
    await this.db.modelCall.create({
      data: {
        projectId: c.payload.projectId,
        agentRunId: c.payload.agentRunId,
        attemptId: c.attemptId,
        sequence,
        status: "STARTED",
      },
    });
  }
  async modelCallFinish(c: StageClaim, call: ModelCallEvent) {
    const pricing = pricingForModel(call.model);
    const cost = estimate("OPENAI", call.model, call.usage, pricing);
    const done = await this.db.modelCall.updateMany({
      where: {
        attemptId: c.attemptId,
        sequence: call.sequence,
        status: "STARTED",
      },
      data: {
        status: call.status,
        model: call.model,
        responseId: call.responseId,
        providerRequestId: call.providerRequestId,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        cachedInputTokens: call.usage.cachedInputTokens,
        estimatedCostUsd: cost,
        pricingVersion: cost !== null ? pricing?.version : null,
        finishedAt: new Date(),
      },
    });
    if (done.count !== 1) throw Error("MODEL_CALL_FINALIZATION_FAILED");
  }
  async toolEvent(
    c: StageClaim,
    e: {
      callId: string;
      name: string;
      inputSummary: string;
      outcome: string;
      durationMs: number;
      outputHash: string | null;
    },
  ) {
    await this.db.toolExecution.create({
      data: {
        projectId: c.payload.projectId,
        agentRunId: c.payload.agentRunId,
        attemptId: c.attemptId,
        callId: e.callId,
        name: e.name,
        inputSummary: e.inputSummary.slice(0, 200),
        outcome: e.outcome.slice(0, 80),
        durationMs: e.durationMs,
        outputHash: e.outputHash,
      },
    });
  }
  async ownedAgent(tx: Tx, c: StageClaim) {
    const t = await this.repo.task(tx, c.payload.taskId);
    const r = await tx.agentRun.findUniqueOrThrow({
      where: { id: c.payload.agentRunId },
    });
    return {
      t,
      r,
      valid:
        t.projectId === c.payload.projectId &&
        t.activeRunId === r.id &&
        t.developmentSessionId === c.sessionId &&
        t.status ===
          (c.agentType === "DEVELOPER" ? "IMPLEMENTING" : "REVIEWING") &&
        r.status === "RUNNING" &&
        r.ownerToken === c.token &&
        !!r.leaseUntil &&
        r.leaseUntil > new Date(),
    };
  }
  private async failRun(
    tx: Tx,
    t: { id: string; projectId: string; status: string },
    runId: string,
    stage: Stage,
    code: string,
    claim?: StageClaim,
  ) {
    const updated = await tx.agentRun.updateMany({
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
    if (updated.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
    await tx.task.update({
      where: { id: t.id },
      data: {
        status: transition(t.status, "FAIL"),
        version: { increment: 1 },
        activeRunId: null,
        failureCode: code,
        failureStage: stage,
      },
    });
    await tx.developmentSession.update({
      where: { taskId: t.id },
      data: { status: "FAILED" },
    });
    await event(tx, t, "STAGE_FAILED", runId, null, runId, { stage, code });
  }
  async failAgent(c: StageClaim, error: ProviderError) {
    return this.repo.transaction(async (tx) => {
      const { t, r, valid } = await this.ownedAgent(tx, c);
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
          ...(error.metadata.usage.inputTokens !== null
            ? { inputTokens: error.metadata.usage.inputTokens }
            : {}),
          ...(error.metadata.usage.outputTokens !== null
            ? { outputTokens: error.metadata.usage.outputTokens }
            : {}),
        },
      });
      if (!error.retryable || r.attemptCount >= 3) {
        await this.failRun(tx, t, r.id, c.agentType, error.code, c);
        return;
      }
      const updated = await tx.agentRun.updateMany({
        where: {
          id: r.id,
          ownerToken: c.token,
          status: "RUNNING",
          leaseUntil: { gt: new Date() },
        },
        data: {
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + backoff(r.attemptCount)),
        },
      });
      if (updated.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
      await event(tx, t, "STAGE_RETRY_SCHEDULED", r.id, null, r.id, {
        stage: c.agentType,
        code: error.code,
      });
    });
  }
  async workspaceActive(c: StageClaim) {
    await this.db.workspaceInstance.updateMany({
      where: {
        attemptId: c.attemptId,
        ownerToken: c.token,
        status: "PREPARING",
      },
      data: { status: "ACTIVE" },
    });
  }
  async workspaceStopped(c: StageClaim) {
    await this.db.workspaceInstance.updateMany({
      where: {
        attemptId: c.attemptId,
        ownerToken: c.token,
        status: { in: ["PREPARING", "ACTIVE"] },
      },
      data: { status: "STOPPED", stoppedAt: new Date() },
    });
  }
  async workspaceCleaned(c: StageClaim) {
    await this.db.workspaceInstance.updateMany({
      where: { attemptId: c.attemptId, ownerToken: c.token },
      data: { status: "CLEANED", cleanedAt: new Date() },
    });
  }
  async completeBlocked(c: StageClaim, result: AgentExecution<unknown>) {
    const output = BusinessDeveloperResult.parse(result.output);
    if (output.outcome !== "BLOCKED") throw Error("INVALID_BLOCKED_RESULT");
    return this.repo.transaction(async (tx) => {
      const { t, r, valid } = await this.ownedAgent(tx, c);
      if (!valid) return false;
      await tx.agentRunAttempt.update({
        where: { id: c.attemptId },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
        },
      });
      const finished = await tx.agentRun.updateMany({
        where: {
          id: r.id,
          status: "RUNNING",
          ownerToken: c.token,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          ownerToken: null,
          leaseUntil: null,
        },
      });
      if (finished.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, "BLOCK"),
          version: { increment: 1 },
          activeRunId: null,
          failureCode: "DEVELOPER_BLOCKED",
        },
      });
      await tx.developmentSession.update({
        where: { id: c.sessionId },
        data: { status: "BLOCKED" },
      });
      await event(tx, t, "DEVELOPMENT_BLOCKED", r.id, null, r.id, {
        round: c.round,
        code: "DEVELOPER_BLOCKED",
      });
      return true;
    });
  }
  async completeDevelopment(
    c: StageClaim,
    result: AgentExecution<unknown>,
    draft: CandidateDraft,
    candidate: Stored,
    diff: Stored,
  ) {
    const output = BusinessDeveloperResult.parse(result.output);
    if (output.outcome !== "IMPLEMENTED") throw Error("DEVELOPER_BLOCKED");
    return this.repo.transaction(async (tx) => {
      const { t, r, valid } = await this.ownedAgent(tx, c);
      if (!valid) return false;
      const session = await tx.developmentSession.findUniqueOrThrow({
        where: { id: c.sessionId },
      });
      if (session.currentRound !== c.round || session.status !== "ACTIVE")
        return false;
      if (candidate.hash === session.baselineHash) throw Error("EMPTY_DIFF");
      const candidateRow = await tx.agentArtifact.create({
        data: {
          projectId: t.projectId,
          taskId: t.id,
          sessionId: c.sessionId,
          producerRunId: r.id,
          attemptId: c.attemptId,
          round: c.round,
          kind: "CANDIDATE",
          hash: candidate.hash,
          snapshotHash: draft.snapshot.hash,
          byteSize: candidate.byteSize,
          storageKey: candidate.storageKey,
        },
      });
      await tx.agentArtifact.create({
        data: {
          projectId: t.projectId,
          taskId: t.id,
          sessionId: c.sessionId,
          producerRunId: r.id,
          attemptId: c.attemptId,
          round: c.round,
          kind: "DIFF",
          hash: diff.hash,
          byteSize: diff.byteSize,
          storageKey: diff.storageKey,
        },
      });
      const validationId = randomUUID();
      await tx.validationRun.create({
        data: {
          id: validationId,
          projectId: t.projectId,
          taskId: t.id,
          sessionId: c.sessionId,
          round: c.round,
          candidateArtifactId: candidateRow.id,
          candidateHash: candidateRow.hash,
          validatorVersion: session.validatorVersion,
        },
      });
      await tx.outboxMessage.create({
        data: {
          projectId: t.projectId,
          taskId: t.id,
          validationRunId: validationId,
          kind: "VALIDATION_REQUESTED",
          payload: json({
            projectId: t.projectId,
            taskId: t.id,
            validationRunId: validationId,
          }),
        },
      });
      await tx.agentRunAttempt.update({
        where: { id: c.attemptId },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          providerRequestId: result.providerRequestId,
        },
      });
      const finalized = await tx.agentRun.updateMany({
        where: {
          id: r.id,
          ownerToken: c.token,
          status: "RUNNING",
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: "SUCCEEDED",
          outputArtifactId: candidateRow.id,
          model: result.model,
          finishedAt: new Date(),
          ownerToken: null,
          leaseUntil: null,
        },
      });
      if (finalized.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
      await tx.developmentSession.update({
        where: { id: session.id },
        data: { currentCandidateId: candidateRow.id },
      });
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, "DEVELOPED"),
          version: { increment: 1 },
          activeRunId: null,
          activeValidationId: validationId,
        },
      });
      await event(tx, t, "CANDIDATE_CREATED", r.id, null, r.id, {
        candidateArtifactId: candidateRow.id,
        candidateHash: candidateRow.hash,
        round: c.round,
        changedFiles: draft.changedFiles,
      });
      return true;
    });
  }
  async claimValidation(
    payload: ValidationPayload,
  ): Promise<ValidationClaim | null> {
    return this.repo.transaction(async (tx) => {
      const t = await this.repo.task(tx, payload.taskId);
      if (
        t.projectId !== payload.projectId ||
        t.activeValidationId !== payload.validationRunId ||
        !["QUEUED_FOR_VALIDATION", "VALIDATING"].includes(t.status)
      )
        return null;
      const v = await tx.validationRun.findUnique({
        where: { id: payload.validationRunId },
      });
      if (
        !v ||
        !v.sessionId ||
        !["QUEUED", "RUNNING"].includes(v.status) ||
        v.nextAttemptAt > new Date() ||
        (v.ownerToken && v.leaseUntil && v.leaseUntil > new Date())
      )
        return null;
      if (v.attemptCount >= 3) {
        await this.failValidation(tx, t, v.id, "ATTEMPT_LIMIT");
        return null;
      }
      const token = randomUUID(),
        now = new Date();
      await tx.validationRun.update({
        where: { id: v.id },
        data: {
          status: "RUNNING",
          ownerToken: token,
          leaseUntil: new Date(now.getTime() + this.leaseMs),
          attemptCount: { increment: 1 },
          startedAt: v.startedAt ?? now,
        },
      });
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, "CLAIM_VALIDATION"),
          version: { increment: 1 },
        },
      });
      await event(tx, t, "VALIDATION_STARTED", v.id, null, null, {
        validationRunId: v.id,
        round: v.round,
      });
      return {
        payload,
        token,
        sessionId: v.sessionId,
        round: v.round,
        candidateArtifactId: v.candidateArtifactId,
        candidateHash: v.candidateHash,
        validatorVersion: v.validatorVersion,
      };
    });
  }
  async heartbeatValidation(c: ValidationClaim) {
    const r = await this.db.validationRun.updateMany({
      where: {
        id: c.payload.validationRunId,
        ownerToken: c.token,
        status: "RUNNING",
        leaseUntil: { gt: new Date() },
      },
      data: { leaseUntil: new Date(Date.now() + this.leaseMs) },
    });
    return r.count === 1;
  }
  async ownedValidation(tx: Tx, c: ValidationClaim) {
    const t = await this.repo.task(tx, c.payload.taskId);
    const v = await tx.validationRun.findUniqueOrThrow({
      where: { id: c.payload.validationRunId },
    });
    return {
      t,
      v,
      valid:
        t.projectId === c.payload.projectId &&
        t.activeValidationId === v.id &&
        t.status === "VALIDATING" &&
        v.status === "RUNNING" &&
        v.ownerToken === c.token &&
        !!v.leaseUntil &&
        v.leaseUntil > new Date(),
    };
  }
  private async failValidation(
    tx: Tx,
    t: { id: string; projectId: string; status: string },
    id: string,
    code: string,
    c?: ValidationClaim,
  ) {
    const update = await tx.validationRun.updateMany({
      where: {
        id,
        status: { in: ["QUEUED", "RUNNING"] },
        ...(c ? { ownerToken: c.token, leaseUntil: { gt: new Date() } } : {}),
      },
      data: {
        status: "ERROR",
        report: json({ status: "ERROR", checks: [], code }),
        finishedAt: new Date(),
        ownerToken: null,
        leaseUntil: null,
      },
    });
    if (update.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
    await tx.task.update({
      where: { id: t.id },
      data: {
        status: transition(t.status, "FAIL"),
        version: { increment: 1 },
        activeValidationId: null,
        failureCode: code,
        failureStage: "VALIDATION",
      },
    });
    await tx.developmentSession.update({
      where: { taskId: t.id },
      data: { status: "FAILED" },
    });
    await event(tx, t, "VALIDATION_ERROR", id, null, null, {
      code,
      validationRunId: id,
    });
  }
  async validationError(c: ValidationClaim, code: string) {
    return this.repo.transaction(async (tx) => {
      const { t, v, valid } = await this.ownedValidation(tx, c);
      if (!valid) return;
      if (v.attemptCount >= 3) {
        await this.failValidation(tx, t, v.id, code, c);
        return;
      }
      const update = await tx.validationRun.updateMany({
        where: {
          id: v.id,
          ownerToken: c.token,
          status: "RUNNING",
          leaseUntil: { gt: new Date() },
        },
        data: {
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + backoff(v.attemptCount)),
        },
      });
      if (update.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
      await event(tx, t, "VALIDATION_RETRY_SCHEDULED", v.id, null, null, {
        validationRunId: v.id,
        code,
      });
    });
  }
  async completeValidation(
    c: ValidationClaim,
    report: { status: "PASS" | "FAIL"; checks: unknown[] },
  ) {
    return this.repo.transaction(async (tx) => {
      const { t, v, valid } = await this.ownedValidation(tx, c);
      if (!valid) return false;
      if (report.status === "PASS" && !requiredValidationPass(report))
        throw Error("INCOMPLETE_VALIDATION_REPORT");
      const session = await tx.developmentSession.findUniqueOrThrow({
        where: { id: c.sessionId },
      });
      const candidate = await tx.agentArtifact.findUniqueOrThrow({
        where: { id: c.candidateArtifactId },
      });
      if (
        candidate.hash !== c.candidateHash ||
        candidate.sessionId !== session.id ||
        session.currentCandidateId !== candidate.id ||
        v.round !== session.currentRound
      )
        throw Error("STALE_CANDIDATE");
      const approvedPlan = await tx.taskPlan.findUniqueOrThrow({
        where: { id: session.approvedPlanId },
      });
      const input = {
        schemaVersion: "1",
        sessionId: session.id,
        round: v.round,
        projectId: t.projectId,
        taskId: t.id,
        task: { title: t.title, description: t.description },
        approvedPlanId: session.approvedPlanId,
        approvedPlan: approvedPlan.content,
        baselineHash: session.baselineHash,
        candidateArtifactId: candidate.id,
        candidateHash: candidate.hash,
        validationRunId: v.id,
        validationReport: report,
      };
      const runId = await this.m2.newRun(
        tx,
        t,
        session.id,
        v.round,
        "REVIEWER",
        input,
      );
      const finished = await tx.validationRun.updateMany({
        where: {
          id: v.id,
          status: "RUNNING",
          ownerToken: c.token,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: report.status,
          report: json(report),
          finishedAt: new Date(),
          ownerToken: null,
          leaseUntil: null,
        },
      });
      if (finished.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
      await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, "VALIDATED"),
          version: { increment: 1 },
          activeValidationId: null,
          activeRunId: runId,
        },
      });
      await event(tx, t, "VALIDATION_COMPLETED", v.id, null, null, {
        validationRunId: v.id,
        status: report.status,
        candidateHash: candidate.hash,
      });
      return true;
    });
  }
  async completeReview(
    c: StageClaim,
    result: AgentExecution<unknown>,
    review: Stored,
  ) {
    const report = BusinessReviewReport.parse(result.output);
    return this.repo.transaction(async (tx) => {
      const { t, r, valid } = await this.ownedAgent(tx, c);
      if (!valid) return false;
      const session = await tx.developmentSession.findUniqueOrThrow({
        where: { id: c.sessionId },
      });
      const input = c.input as {
        candidateArtifactId?: string;
        candidateHash?: string;
        validationRunId?: string;
      };
      const candidate = await tx.agentArtifact.findUniqueOrThrow({
        where: { id: input.candidateArtifactId },
      });
      const validation = await tx.validationRun.findUniqueOrThrow({
        where: { id: input.validationRunId },
      });
      if (
        candidate.id !== session.currentCandidateId ||
        candidate.hash !== input.candidateHash ||
        candidate.round !== c.round ||
        validation.candidateArtifactId !== candidate.id ||
        validation.round !== c.round ||
        !["PASS", "FAIL"].includes(validation.status)
      )
        throw Error("STALE_REVIEW_INPUT");
      const reviewRow = await tx.agentArtifact.create({
        data: {
          projectId: t.projectId,
          taskId: t.id,
          sessionId: session.id,
          producerRunId: r.id,
          attemptId: c.attemptId,
          round: c.round,
          kind: "REVIEW_REPORT",
          hash: review.hash,
          byteSize: review.byteSize,
          storageKey: review.storageKey,
        },
      });
      await tx.agentRunAttempt.update({
        where: { id: c.attemptId },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          providerRequestId: result.providerRequestId,
        },
      });
      const finished = await tx.agentRun.updateMany({
        where: {
          id: r.id,
          ownerToken: c.token,
          status: "RUNNING",
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: "SUCCEEDED",
          outputArtifactId: reviewRow.id,
          model: result.model,
          finishedAt: new Date(),
          ownerToken: null,
          leaseUntil: null,
        },
      });
      if (finished.count !== 1) throw Error("LEASE_LOST_DURING_FINALIZATION");
      const pass =
        validation.status === "PASS" &&
        requiredValidationPass(validation.report) &&
        report.verdict === "APPROVE" &&
        !report.issues.some((i) => ["HIGH", "CRITICAL"].includes(i.severity));
      let status: string;
      if (pass) {
        status = transition(t.status, "FINAL_READY");
        const target = FinalTarget.parse({
          candidateArtifactId: candidate.id,
          candidateHash: candidate.hash,
          validationRunId: validation.id,
          reviewArtifactId: reviewRow.id,
          approvedPlanId: session.approvedPlanId,
          baselineHash: session.baselineHash,
          policyVersion: session.policyVersion,
          validatorVersion: session.validatorVersion,
          sessionId: session.id,
          round: c.round,
        });
        await tx.approval.create({
          data: {
            taskId: t.id,
            projectId: t.projectId,
            type: "FINAL_CODE",
            targetArtifactId: candidate.id,
            targetSnapshot: json(target),
          },
        });
        await tx.task.update({
          where: { id: t.id },
          data: { status, version: { increment: 1 }, activeRunId: null },
        });
        await event(tx, t, "FINAL_APPROVAL_CREATED", r.id, null, r.id, {
          candidateArtifactId: candidate.id,
          candidateHash: candidate.hash,
          validationRunId: validation.id,
          reviewArtifactId: reviewRow.id,
        });
      } else if (report.verdict === "BLOCK") {
        status = transition(t.status, "BLOCK");
        await tx.task.update({
          where: { id: t.id },
          data: { status, version: { increment: 1 }, activeRunId: null },
        });
        await tx.developmentSession.update({
          where: { id: session.id },
          data: { status: "BLOCKED" },
        });
      } else if (c.round >= 3) {
        status = transition(t.status, "ROUND_LIMIT");
        await tx.task.update({
          where: { id: t.id },
          data: { status, version: { increment: 1 }, activeRunId: null },
        });
        await tx.developmentSession.update({
          where: { id: session.id },
          data: { status: "HUMAN_REVIEW_REQUIRED" },
        });
      } else {
        status = transition(t.status, "FIX_ROUND");
        const prior = await tx.taskPlan.findUniqueOrThrow({
          where: { id: session.approvedPlanId },
        });
        const next = c.round + 1;
        const inputNext = {
          schemaVersion: "1",
          sessionId: session.id,
          round: next,
          projectId: t.projectId,
          taskId: t.id,
          approvedPlanId: session.approvedPlanId,
          task: { title: t.title, description: t.description },
          approvedPlan: prior.content,
          source: {
            sourceId: session.sourceId,
            sourceVersion: session.sourceVersion,
            baselineHash: session.baselineHash,
            policyVersion: session.policyVersion,
            validatorVersion: session.validatorVersion,
          },
          inputArtifactId: candidate.id,
          inputCandidateHash: candidate.hash,
          previousReview: report,
          previousValidation: validation.report,
        };
        const developerId = await this.m2.newRun(
          tx,
          t,
          session.id,
          next,
          "DEVELOPER",
          inputNext,
        );
        await tx.developmentSession.update({
          where: { id: session.id },
          data: { currentRound: next },
        });
        await tx.task.update({
          where: { id: t.id },
          data: { status, version: { increment: 1 }, activeRunId: developerId },
        });
        await event(tx, t, "FIX_ROUND_REQUESTED", r.id, null, r.id, {
          round: next,
          developerRunId: developerId,
        });
      }
      await event(tx, t, "REVIEW_COMPLETED", r.id, null, r.id, {
        round: c.round,
        verdict: report.verdict,
        status,
        reviewArtifactId: reviewRow.id,
      });
      return true;
    });
  }
  pending() {
    return this.db.outboxMessage.findMany({
      where: {
        status: "PENDING",
        kind: { not: "PLAN_REQUESTED" },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  }
  recoverableAgents() {
    return this.db.agentRun.findMany({
      where: {
        agentType: { in: ["DEVELOPER", "REVIEWER"] },
        status: { in: ["QUEUED", "RUNNING"] },
        outbox: { some: { status: "DISPATCHED" } },
        nextAttemptAt: { lte: new Date() },
        OR: [{ ownerToken: null }, { leaseUntil: { lte: new Date() } }],
      },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
  }
  recoverableValidation() {
    return this.db.validationRun.findMany({
      where: {
        status: { in: ["QUEUED", "RUNNING"] },
        nextAttemptAt: { lte: new Date() },
        OR: [{ ownerToken: null }, { leaseUntil: { lte: new Date() } }],
      },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
  }
}
