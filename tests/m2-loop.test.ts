import "dotenv/config";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  PrismaClient,
  PlatformRepository,
  WorkerRepository,
  M2Repository,
  M2WorkerRepository,
  type Command,
} from "@company/database";
import {
  DemoProvider,
  ProviderError,
  productDefinition,
} from "@company/agents";
import {
  processDevelopment,
  processValidation,
  processReview,
} from "../apps/worker/src/m2-processors";
import { type JobPayload } from "@company/contracts";
import { M2Dispatcher, stageQueue } from "@company/integrations";
import { DockerWorkspaceBackend } from "@company/workspace";
import { reconcileWorkspaces } from "../apps/worker/src/m2-reconcile";
let db: PrismaClient,
  repo: PlatformRepository,
  worker: WorkerRepository,
  m2: M2Repository,
  stage: M2WorkerRepository;
const schema = "m2_test_" + randomUUID().replaceAll("-", "");
const originalUrl = process.env.DATABASE_URL!;
const testUrl = new URL(originalUrl);
testUrl.searchParams.set("schema", schema);
const context = {
  product: "Small todo store with create and list operations.",
  architecture: "JavaScript ESM on Node 24, no dependencies.",
  codingStandards: "Small pure functions.",
  testing: "Node built-in test runner.",
  security: "No external network.",
  decisions: "Use sample-todo-v1.",
};
function command(id: string, operation: string, body: unknown = {}): Command {
  return {
    resourceId: id,
    operation,
    body,
    key: randomUUID(),
    actorId: "operator",
    correlationId: randomUUID(),
  };
}
async function approved(title = "Complete todos") {
  const p = await repo.createProject(
    {
      name: "Sample Todo",
      description: "M2 fixture",
      context,
      workspaceSourceId: "sample-todo-v1",
    },
    "operator",
    randomUUID(),
  );
  const t = await repo.createTask(
    p.id,
    {
      title,
      description:
        "Add completion to todos and optionally hide completed todos. Preserve create and list behavior.",
      priority: "NORMAL",
    },
    "operator",
    randomUUID(),
  );
  const start = (await repo.start(command(t.id, "PLAN"), "PLAN")) as {
    runId: string;
  };
  const claim = await worker.claim({
    projectId: p.id,
    taskId: t.id,
    agentRunId: start.runId,
  });
  const plan = await new DemoProvider().execute(
    productDefinition,
    claim!.input,
    { signal: new AbortController().signal, runId: start.runId },
  );
  await worker.complete(claim!, plan);
  const before = await repo.detail(t.id);
  await repo.decide(
    command(before.approvals[0]!.id, "APPROVE", {
      planId: before.currentPlanId,
      expectedTaskVersion: before.version,
    }),
    "APPROVE",
    { planId: before.currentPlanId!, expectedTaskVersion: before.version },
  );
  return { p, t: await repo.detail(t.id) };
}
beforeAll(async () => {
  process.env.DATABASE_URL = testUrl.toString();
  execFileSync("corepack", ["pnpm", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "pipe",
  });
  db = new PrismaClient();
  await db.$connect();
  repo = new PlatformRepository(db, "DEMO", null);
  worker = new WorkerRepository(repo, 30000);
  m2 = new M2Repository(repo);
  stage = new M2WorkerRepository(repo, 30000);
});
afterAll(async () => {
  await db.$disconnect();
  const admin = new PrismaClient({ datasourceUrl: originalUrl });
  await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.$disconnect();
  process.env.DATABASE_URL = originalUrl;
});
describe("M2 offline development loop with real database and Docker", () => {
  it("requires explicit start, creates a frozen validated candidate, and binds final approval", async () => {
    const { p, t } = await approved();
    expect(t.status).toBe("PLAN_APPROVED");
    expect(await db.developmentSession.count({ where: { taskId: t.id } })).toBe(
      0,
    );
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const cmd = command(t.id, "START_DEVELOPMENT", body);
    const [start, replay] = await Promise.all([
      m2.start(cmd, body),
      m2.start(cmd, body),
    ]);
    expect(start).toEqual(replay);
    expect(await db.developmentSession.count({ where: { taskId: t.id } })).toBe(
      1,
    );
    const runId = (start as { runId: string }).runId;
    const payload: JobPayload = {
      projectId: p.id,
      taskId: t.id,
      agentRunId: runId,
    };
    await processDevelopment(payload, stage);
    let current = await repo.detail(t.id);
    expect(current.status).toBe("QUEUED_FOR_VALIDATION");
    expect(
      await db.agentArtifact.count({
        where: { taskId: t.id, kind: "CANDIDATE" },
      }),
    ).toBe(1);
    await processValidation(
      {
        projectId: p.id,
        taskId: t.id,
        validationRunId: current.activeValidationId!,
      },
      stage,
    );
    current = await repo.detail(t.id);
    expect(current.status).toBe("QUEUED_FOR_REVIEW");
    const validation = await db.validationRun.findUniqueOrThrow({
      where: {
        id: (
          await db.validationRun.findFirstOrThrow({ where: { taskId: t.id } })
        ).id,
      },
    });
    expect(validation.status).toBe("PASS");
    await processReview(
      { projectId: p.id, taskId: t.id, agentRunId: current.activeRunId! },
      stage,
    );
    current = await repo.detail(t.id);
    expect(current.status).toBe("WAITING_FINAL_APPROVAL");
    const final = current.approvals.find((a) => a.type === "FINAL_CODE")!;
    const target = final.targetSnapshot as {
      candidateArtifactId: string;
      candidateHash: string;
      validationRunId: string;
      reviewArtifactId: string;
    };
    await expect(
      m2.final(command(final.id, "FINAL_APPROVE"), "APPROVE", {
        ...target,
        expectedTaskVersion: current.version - 1,
      }),
    ).rejects.toMatchObject({ code: "STALE_FINAL_APPROVAL" });
    await m2.final(command(final.id, "FINAL_APPROVE"), "APPROVE", {
      ...target,
      expectedTaskVersion: current.version,
    });
    expect((await repo.detail(t.id)).status).toBe("DONE");
    expect(await stage.claimAgent(payload, "DEVELOPER")).toBeNull();
  }, 120000);
  it("validation FAIL cannot be overridden by an approving reviewer", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    await processDevelopment(
      { projectId: p.id, taskId: t.id, agentRunId: started.runId },
      stage,
    );
    const queued = await repo.detail(t.id);
    const claim = await stage.claimValidation({
      projectId: p.id,
      taskId: t.id,
      validationRunId: queued.activeValidationId!,
    });
    expect(claim).not.toBeNull();
    await stage.completeValidation(claim!, {
      status: "FAIL",
      checks: [{ commandId: "acceptance", exitCode: 1, timedOut: false }],
    });
    const review = await repo.detail(t.id);
    await processReview(
      { projectId: p.id, taskId: t.id, agentRunId: review.activeRunId! },
      stage,
    );
    const after = await repo.detail(t.id);
    expect(after.status).toBe("QUEUED_FOR_IMPLEMENTATION");
    expect(after.approvals.filter((a) => a.type === "FINAL_CODE")).toHaveLength(
      0,
    );
  }, 120000);
  it("stops after three review rounds and never queues a fourth", async () => {
    const { p, t } = await approved("demo-always-changes: complete todos");
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    await m2.start(command(t.id, "START_DEVELOPMENT", body), body);
    for (let round = 1; round <= 3; round++) {
      let current = await repo.detail(t.id);
      await processDevelopment(
        { projectId: p.id, taskId: t.id, agentRunId: current.activeRunId! },
        stage,
      );
      current = await repo.detail(t.id);
      await processValidation(
        {
          projectId: p.id,
          taskId: t.id,
          validationRunId: current.activeValidationId!,
        },
        stage,
      );
      current = await repo.detail(t.id);
      await processReview(
        { projectId: p.id, taskId: t.id, agentRunId: current.activeRunId! },
        stage,
      );
      current = await repo.detail(t.id);
      expect(current.status).toBe(
        round === 3 ? "HUMAN_REVIEW_REQUIRED" : "QUEUED_FOR_IMPLEMENTATION",
      );
    }
    expect(
      await db.agentRun.count({
        where: { taskId: t.id, agentType: "DEVELOPER" },
      }),
    ).toBe(3);
    expect(
      await db.approval.count({ where: { taskId: t.id, type: "FINAL_CODE" } }),
    ).toBe(0);
  }, 120000);
  it("rejects duplicate delivery and stale lease results after ownership changes", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    const payload = {
      projectId: p.id,
      taskId: t.id,
      agentRunId: started.runId,
    };
    const [first, duplicate] = await Promise.all([
      stage.claimAgent(payload, "DEVELOPER"),
      stage.claimAgent(payload, "DEVELOPER"),
    ]);
    expect([first, duplicate].filter(Boolean)).toHaveLength(1);
    const old = first ?? duplicate!;
    await db.agentRun.update({
      where: { id: started.runId },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const fresh = await stage.claimAgent(payload, "DEVELOPER");
    expect(fresh?.token).not.toBe(old.token);
    expect(
      (
        await db.agentRunAttempt.findUniqueOrThrow({
          where: { id: old.attemptId },
        })
      ).status,
    ).toBe("INTERRUPTED");
    const stored = { hash: "0".repeat(64), byteSize: 1, storageKey: "fake" };
    const late = await stage.completeDevelopment(
      old,
      {
        output: {
          schemaVersion: "1",
          outcome: "IMPLEMENTED",
          summary: "late",
          claimedChangedFiles: ["src/todo.js"],
          claimedChecks: [],
          remainingRisks: [],
          blockingReason: null,
        },
        provider: "DEMO",
        model: null,
        providerRequestId: null,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
      {
        snapshot: {
          sourceId: "sample-todo-v1",
          sourceVersion: "1",
          files: [],
          hash: "bad",
        },
        diff: "late",
        changedFiles: ["src/todo.js"],
      },
      stored,
      stored,
    );
    expect(late).toBe(false);
    expect(
      await db.agentArtifact.count({
        where: { taskId: t.id, kind: "CANDIDATE" },
      }),
    ).toBe(0);
    await repo.cancel(t.id, "operator", randomUUID());
    expect((await repo.detail(t.id)).status).toBe("CANCELLED");
    await processDevelopment(payload, stage);
    expect(
      await db.agentArtifact.count({
        where: { taskId: t.id, kind: "CANDIDATE" },
      }),
    ).toBe(0);
    expect(await stage.claimAgent(payload, "DEVELOPER")).toBeNull();
    expect(
      (
        await db.agentRunAttempt.findUniqueOrThrow({
          where: { id: fresh!.attemptId },
        })
      ).status,
    ).toBe("CANCELLED");
  }, 120000);
  it("adds every model call cost once, including failed and unknown calls", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    const claim = await stage.claimAgent(
      { projectId: p.id, taskId: t.id, agentRunId: started.runId },
      "DEVELOPER",
    );
    expect(claim).not.toBeNull();
    const before = await repo.dashboard();
    await stage.modelCallStart(claim!, 1);
    await stage.modelCallFinish(claim!, {
      sequence: 1,
      status: "SUCCEEDED",
      model: "gpt-4.1-mini-2025-04-14",
      usage: { inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0 },
      providerRequestId: "request-1",
      responseId: "response-1",
    });
    await stage.modelCallStart(claim!, 2);
    await stage.modelCallFinish(claim!, {
      sequence: 2,
      status: "FAILED",
      model: "gpt-4.1-mini-2025-04-14",
      usage: { inputTokens: 500, outputTokens: 200, cachedInputTokens: 0 },
      providerRequestId: "request-2",
      responseId: "response-2",
    });
    await stage.modelCallStart(claim!, 3);
    const after = await repo.dashboard();
    expect(
      Number(after.knownEstimatedCostUsd) -
        Number(before.knownEstimatedCostUsd),
    ).toBeCloseTo(0.00252, 8);
    expect(after.unknownAttempts - before.unknownAttempts).toBe(1);
    const runs = await repo.runs(t.id);
    const attempt = runs.find((r) => r.id === started.runId)!.attempts[0]!;
    expect(attempt.modelCalls).toHaveLength(3);
    expect(attempt.unknownModelCalls).toBe(1);
    expect(attempt.estimatedCostUsd?.toFixed(8)).toBe("0.00252000");
    await repo.cancel(t.id, "operator", randomUUID());
    expect((await repo.dashboard()).knownEstimatedCostUsd).toBe(
      after.knownEstimatedCostUsd,
    );
  }, 120000);
  it("reconciles lost Redis jobs for development, validation and review", async () => {
    const prefix = "m2_redelivery_" + randomUUID().replaceAll("-", "");
    const queues = {
      development: stageQueue<JobPayload>(
        "development",
        process.env.REDIS_URL!,
        prefix,
      ),
      validation: stageQueue<{
        projectId: string;
        taskId: string;
        validationRunId: string;
      }>("validation", process.env.REDIS_URL!, prefix),
      review: stageQueue<JobPayload>("review", process.env.REDIS_URL!, prefix),
    };
    try {
      const dispatcher = new M2Dispatcher(stage, queues);
      const { p, t } = await approved();
      const body = {
        approvedPlanId: t.approvedPlanId!,
        expectedTaskVersion: t.version,
        sourceId: "sample-todo-v1" as const,
      };
      const started = (await m2.start(
        command(t.id, "START_DEVELOPMENT", body),
        body,
      )) as { runId: string };
      const devId = "development-" + started.runId;
      await dispatcher.tick();
      expect(await queues.development.getJob(devId)).not.toBeNull();
      await queues.development.obliterate({ force: true });
      await dispatcher.tick();
      expect(await queues.development.getJob(devId)).not.toBeNull();
      await processDevelopment(
        { projectId: p.id, taskId: t.id, agentRunId: started.runId },
        stage,
      );
      const validating = await repo.detail(t.id);
      const validationId = "validation-" + validating.activeValidationId;
      await dispatcher.tick();
      expect(await queues.validation.getJob(validationId)).not.toBeNull();
      await queues.validation.obliterate({ force: true });
      await dispatcher.tick();
      expect(await queues.validation.getJob(validationId)).not.toBeNull();
      await processValidation(
        {
          projectId: p.id,
          taskId: t.id,
          validationRunId: validating.activeValidationId!,
        },
        stage,
      );
      const reviewing = await repo.detail(t.id);
      const reviewId = "review-" + reviewing.activeRunId;
      await dispatcher.tick();
      expect(await queues.review.getJob(reviewId)).not.toBeNull();
      await queues.review.obliterate({ force: true });
      await dispatcher.tick();
      expect(await queues.review.getJob(reviewId)).not.toBeNull();
      await processReview(
        { projectId: p.id, taskId: t.id, agentRunId: reviewing.activeRunId! },
        stage,
      );
      expect((await repo.detail(t.id)).status).toBe("WAITING_FINAL_APPROVAL");
      await dispatcher.tick();
      expect(
        await db.agentArtifact.count({
          where: { taskId: t.id, kind: "CANDIDATE" },
        }),
      ).toBe(1);
    } finally {
      for (const q of Object.values(queues)) {
        await q.obliterate({ force: true });
        await q.close();
      }
    }
  }, 120000);
  it("recovers a SIGKILL after Docker prepare and removes its orphan workspace", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    const payload = {
      projectId: p.id,
      taskId: t.id,
      agentRunId: started.runId,
    };
    const child = fork("tests/helpers/m2-crash-worker.ts", [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, M2_CRASH_PAYLOAD: JSON.stringify(payload) },
      silent: true,
    });
    try {
      const [message] = await Promise.race([
        once(child, "message"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(Error("CRASH_HELPER_TIMEOUT")), 15000),
        ),
      ]);
      const orphan = message as { attemptId: string; container: string };
      expect(
        execFileSync(
          "docker",
          ["inspect", orphan.container, "--format", "{{.State.Running}}"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("true");
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      await db.agentRun.update({
        where: { id: started.runId },
        data: { leaseUntil: new Date(0) },
      });
      await reconcileWorkspaces(db, new DockerWorkspaceBackend());
      expect(() =>
        execFileSync("docker", ["inspect", orphan.container], {
          stdio: "ignore",
        }),
      ).toThrow();
      expect(
        (
          await db.workspaceInstance.findUniqueOrThrow({
            where: { attemptId: orphan.attemptId },
          })
        ).status,
      ).toBe("CLEANED");
      await processDevelopment(payload, stage);
      expect((await repo.detail(t.id)).status).toBe("QUEUED_FOR_VALIDATION");
      expect(
        (
          await db.agentRunAttempt.findMany({
            where: { agentRunId: started.runId },
            orderBy: { attemptNumber: "asc" },
          })
        ).map((a) => a.status),
      ).toEqual(["INTERRUPTED", "SUCCEEDED"]);
      expect(
        await db.agentArtifact.count({
          where: { taskId: t.id, kind: "CANDIDATE" },
        }),
      ).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }, 120000);
  it("retries a failed Reviewer on the same frozen candidate without a new Developer or validator", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    await processDevelopment(
      { projectId: p.id, taskId: t.id, agentRunId: started.runId },
      stage,
    );
    let current = await repo.detail(t.id);
    await processValidation(
      {
        projectId: p.id,
        taskId: t.id,
        validationRunId: current.activeValidationId!,
      },
      stage,
    );
    current = await repo.detail(t.id);
    const oldReviewId = current.activeRunId!;
    const claim = await stage.claimAgent(
      { projectId: p.id, taskId: t.id, agentRunId: oldReviewId },
      "REVIEWER",
    );
    expect(claim).not.toBeNull();
    await stage.failAgent(claim!, new ProviderError("PROVIDER_AUTH", false));
    current = await repo.detail(t.id);
    expect(current.status).toBe("FAILED");
    const retry = {
      expectedTaskVersion: current.version,
      failureStage: "REVIEWER" as const,
      targetId: oldReviewId,
    };
    await m2.retry(command(t.id, "RETRY_STAGE", retry), retry);
    current = await repo.detail(t.id);
    const replacement = current.activeRunId!;
    expect(replacement).not.toBe(oldReviewId);
    expect(
      (await db.agentRun.findUniqueOrThrow({ where: { id: replacement } }))
        .inputSnapshot,
    ).toEqual(
      (await db.agentRun.findUniqueOrThrow({ where: { id: oldReviewId } }))
        .inputSnapshot,
    );
    await processReview(
      { projectId: p.id, taskId: t.id, agentRunId: replacement },
      stage,
    );
    expect((await repo.detail(t.id)).status).toBe("WAITING_FINAL_APPROVAL");
    expect(
      await db.agentArtifact.count({
        where: { taskId: t.id, kind: "CANDIDATE" },
      }),
    ).toBe(1);
    expect(await db.validationRun.count({ where: { taskId: t.id } })).toBe(1);
    expect(
      await db.agentRun.count({
        where: { taskId: t.id, agentType: "DEVELOPER" },
      }),
    ).toBe(1);
  }, 120000);
  it("retries validator errors on the same candidate without calling a model", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    await processDevelopment(
      { projectId: p.id, taskId: t.id, agentRunId: started.runId },
      stage,
    );
    let current = await repo.detail(t.id);
    const oldValidationId = current.activeValidationId!;
    for (let i = 0; i < 3; i++) {
      const claim = await stage.claimValidation({
        projectId: p.id,
        taskId: t.id,
        validationRunId: oldValidationId,
      });
      expect(claim).not.toBeNull();
      await stage.validationError(claim!, "VALIDATOR_ERROR");
      if (i < 2)
        await db.validationRun.update({
          where: { id: oldValidationId },
          data: { nextAttemptAt: new Date(0) },
        });
    }
    current = await repo.detail(t.id);
    expect(current.status).toBe("FAILED");
    const retry = {
      expectedTaskVersion: current.version,
      failureStage: "VALIDATION" as const,
      targetId: oldValidationId,
    };
    await m2.retry(command(t.id, "RETRY_STAGE", retry), retry);
    current = await repo.detail(t.id);
    const newValidationId = current.activeValidationId!;
    expect(newValidationId).not.toBe(oldValidationId);
    await processValidation(
      { projectId: p.id, taskId: t.id, validationRunId: newValidationId },
      stage,
    );
    expect(
      (
        await db.validationRun.findUniqueOrThrow({
          where: { id: newValidationId },
        })
      ).status,
    ).toBe("PASS");
    expect(
      await db.agentArtifact.count({
        where: { taskId: t.id, kind: "CANDIDATE" },
      }),
    ).toBe(1);
    expect(await db.modelCall.count({ where: { projectId: p.id } })).toBe(0);
  }, 120000);
  it("binds final approval to the exact hash and commits only one concurrent human decision", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    await processDevelopment(
      { projectId: p.id, taskId: t.id, agentRunId: started.runId },
      stage,
    );
    let current = await repo.detail(t.id);
    await processValidation(
      {
        projectId: p.id,
        taskId: t.id,
        validationRunId: current.activeValidationId!,
      },
      stage,
    );
    current = await repo.detail(t.id);
    await processReview(
      { projectId: p.id, taskId: t.id, agentRunId: current.activeRunId! },
      stage,
    );
    current = await repo.detail(t.id);
    const approval = current.approvals.find((a) => a.type === "FINAL_CODE")!;
    const target = approval.targetSnapshot as {
      candidateArtifactId: string;
      candidateHash: string;
      validationRunId: string;
      reviewArtifactId: string;
    };
    const decision = { ...target, expectedTaskVersion: current.version };
    await expect(
      m2.final(
        command(approval.id, "FINAL_APPROVE", {
          ...decision,
          candidateHash: "0".repeat(64),
        }),
        "APPROVE",
        { ...decision, candidateHash: "0".repeat(64) },
      ),
    ).rejects.toMatchObject({ code: "STALE_FINAL_APPROVAL" });
    await expect(
      m2.final(
        command(approval.id, "FINAL_APPROVE", {
          ...decision,
          reviewArtifactId: randomUUID(),
        }),
        "APPROVE",
        { ...decision, reviewArtifactId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "STALE_FINAL_APPROVAL" });
    const results = await Promise.allSettled([
      m2.final(
        command(approval.id, "FINAL_APPROVE", decision),
        "APPROVE",
        decision,
      ),
      m2.final(
        command(approval.id, "FINAL_REJECT", decision),
        "REJECT",
        decision,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(["DONE", "REJECTED"]).toContain((await repo.detail(t.id)).status);
    expect(
      await db.event.count({
        where: {
          taskId: t.id,
          type: { in: ["CODE_APPROVED", "CODE_REJECTED"] },
        },
      }),
    ).toBe(1);
  }, 120000);
  it("cancels validation and review without publishing late results", async () => {
    for (const stageToCancel of ["VALIDATION", "REVIEWER"] as const) {
      const { p, t } = await approved();
      const body = {
        approvedPlanId: t.approvedPlanId!,
        expectedTaskVersion: t.version,
        sourceId: "sample-todo-v1" as const,
      };
      const started = (await m2.start(
        command(t.id, "START_DEVELOPMENT", body),
        body,
      )) as { runId: string };
      await processDevelopment(
        { projectId: p.id, taskId: t.id, agentRunId: started.runId },
        stage,
      );
      let current = await repo.detail(t.id);
      if (stageToCancel === "VALIDATION") {
        const claim = await stage.claimValidation({
          projectId: p.id,
          taskId: t.id,
          validationRunId: current.activeValidationId!,
        });
        expect(claim).not.toBeNull();
        await repo.cancel(t.id, "operator", randomUUID());
        expect(
          await stage.completeValidation(claim!, {
            status: "PASS",
            checks: [{ commandId: "acceptance", exitCode: 0, timedOut: false }],
          }),
        ).toBe(false);
        expect(
          await db.agentRun.count({
            where: { taskId: t.id, agentType: "REVIEWER" },
          }),
        ).toBe(0);
      } else {
        await processValidation(
          {
            projectId: p.id,
            taskId: t.id,
            validationRunId: current.activeValidationId!,
          },
          stage,
        );
        current = await repo.detail(t.id);
        const claim = await stage.claimAgent(
          { projectId: p.id, taskId: t.id, agentRunId: current.activeRunId! },
          "REVIEWER",
        );
        expect(claim).not.toBeNull();
        await repo.cancel(t.id, "operator", randomUUID());
        expect(
          await stage.completeReview(
            claim!,
            {
              output: {
                schemaVersion: "1",
                verdict: "APPROVE",
                summary: "late",
                issues: [],
              },
              provider: "DEMO",
              model: null,
              providerRequestId: null,
              usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
            },
            { hash: "0".repeat(64), byteSize: 1, storageKey: "late" },
          ),
        ).toBe(false);
      }
      expect((await repo.detail(t.id)).status).toBe("CANCELLED");
      expect(
        await db.approval.count({
          where: { taskId: t.id, type: "FINAL_CODE" },
        }),
      ).toBe(0);
    }
  }, 120000);
  it("reclaims validation and Reviewer stages after a real SIGKILL", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    await processDevelopment(
      { projectId: p.id, taskId: t.id, agentRunId: started.runId },
      stage,
    );
    let current = await repo.detail(t.id);
    const validationId = current.activeValidationId!;
    async function crash(
      stageName: "VALIDATION" | "REVIEWER",
      payload: unknown,
    ) {
      const child = fork("tests/helpers/m2-crash-worker.ts", [], {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          M2_CRASH_STAGE: stageName,
          M2_CRASH_PAYLOAD: JSON.stringify(payload),
        },
        silent: true,
      });
      try {
        await Promise.race([
          once(child, "message"),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Error("CRASH_HELPER_TIMEOUT")), 15000),
          ),
        ]);
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }
    await crash("VALIDATION", {
      projectId: p.id,
      taskId: t.id,
      agentRunId: started.runId,
      validationRunId: validationId,
    });
    await db.validationRun.update({
      where: { id: validationId },
      data: { leaseUntil: new Date(0) },
    });
    await processValidation(
      { projectId: p.id, taskId: t.id, validationRunId: validationId },
      stage,
    );
    expect(
      (
        await db.validationRun.findUniqueOrThrow({
          where: { id: validationId },
        })
      ).attemptCount,
    ).toBe(2);
    current = await repo.detail(t.id);
    const reviewId = current.activeRunId!;
    await crash("REVIEWER", {
      projectId: p.id,
      taskId: t.id,
      agentRunId: reviewId,
    });
    await db.agentRun.update({
      where: { id: reviewId },
      data: { leaseUntil: new Date(0) },
    });
    await processReview(
      { projectId: p.id, taskId: t.id, agentRunId: reviewId },
      stage,
    );
    expect((await repo.detail(t.id)).status).toBe("WAITING_FINAL_APPROVAL");
    expect(
      (
        await db.agentRunAttempt.findMany({
          where: { agentRunId: reviewId },
          orderBy: { attemptNumber: "asc" },
        })
      ).map((a) => a.status),
    ).toEqual(["INTERRUPTED", "SUCCEEDED"]);
    expect(
      await db.approval.count({ where: { taskId: t.id, type: "FINAL_CODE" } }),
    ).toBe(1);
  }, 120000);
  it("recovers SIGKILL after artifact publication but before the candidate DB commit", async () => {
    const { p, t } = await approved();
    const body = {
      approvedPlanId: t.approvedPlanId!,
      expectedTaskVersion: t.version,
      sourceId: "sample-todo-v1" as const,
    };
    const started = (await m2.start(
      command(t.id, "START_DEVELOPMENT", body),
      body,
    )) as { runId: string };
    const payload = {
      projectId: p.id,
      taskId: t.id,
      agentRunId: started.runId,
    };
    const child = fork("tests/helpers/m2-crash-worker.ts", [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        M2_CRASH_STAGE: "ARTIFACT_PUBLISHED",
        M2_CRASH_PAYLOAD: JSON.stringify(payload),
      },
      silent: true,
    });
    try {
      const exited = once(child, "exit");
      const [message] = await Promise.race([
        once(child, "message"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(Error("CRASH_HELPER_TIMEOUT")), 15000),
        ),
      ]);
      expect((message as { storageKey: string }).storageKey).toMatch(
        /^[a-f0-9]{64}\.json$/,
      );
      await exited;
      expect(
        await db.agentArtifact.count({
          where: { taskId: t.id, kind: "CANDIDATE" },
        }),
      ).toBe(0);
      await db.agentRun.update({
        where: { id: started.runId },
        data: { leaseUntil: new Date(0) },
      });
      await reconcileWorkspaces(db, new DockerWorkspaceBackend());
      await processDevelopment(payload, stage);
      expect((await repo.detail(t.id)).status).toBe("QUEUED_FOR_VALIDATION");
      expect(
        await db.agentArtifact.count({
          where: { taskId: t.id, kind: "CANDIDATE" },
        }),
      ).toBe(1);
      expect(
        (
          await db.agentRunAttempt.findMany({
            where: { agentRunId: started.runId },
            orderBy: { attemptNumber: "asc" },
          })
        ).map((a) => a.status),
      ).toEqual(["INTERRUPTED", "SUCCEEDED"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }, 120000);
});
