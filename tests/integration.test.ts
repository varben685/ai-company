import "dotenv/config";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  PrismaClient,
  PlatformRepository,
  WorkerRepository,
  type Command,
} from "@company/database";
import {
  DemoProvider,
  ProviderError,
  productDefinition,
  type AgentExecution,
  type AgentProvider,
} from "@company/agents";
import {
  Dispatcher,
  planningQueue,
  redisConnection,
  jobId,
} from "@company/integrations";
import { Worker } from "bullmq";
import { processPlanning } from "../apps/worker/src/processor";
import { createApi } from "../apps/api/src/app";
import { project, task, plan } from "./fixtures";
let db: PrismaClient;
let repo: PlatformRepository;
let worker: WorkerRepository;
const schema = "m1_test_" + randomUUID().replaceAll("-", "");
const originalUrl = process.env.DATABASE_URL!;
const testUrl = new URL(originalUrl);
testUrl.searchParams.set("schema", schema);
const provider = new DemoProvider();
function command(
  id: string,
  operation = "PLAN",
  body: unknown = {},
  key = randomUUID(),
): Command {
  return {
    resourceId: id,
    operation,
    body,
    key,
    actorId: "operator",
    correlationId: randomUUID(),
  };
}
async function fixture() {
  const p = await repo.createProject(project, "operator", randomUUID());
  const t = await repo.createTask(p.id, task, "operator", randomUUID());
  return { p, t };
}
async function queued() {
  const f = await fixture();
  const r = (await repo.start(command(f.t.id), "PLAN")) as { runId: string };
  return {
    ...f,
    payload: { projectId: f.p.id, taskId: f.t.id, agentRunId: r.runId },
  };
}
async function completed() {
  const f = await queued();
  const claim = await worker.claim(f.payload);
  expect(claim).not.toBeNull();
  const result = await provider.execute(productDefinition, claim!.input, {
    signal: new AbortController().signal,
    runId: f.payload.agentRunId,
  });
  await worker.complete(claim!, result);
  const detail = await repo.detail(f.t.id);
  return {
    ...f,
    claim: claim!,
    result,
    detail,
    approval: detail.approvals[0]!,
  };
}
async function until(fn: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Condition timed out");
}
beforeAll(async () => {
  process.env.DATABASE_URL = testUrl.toString();
  execFileSync("corepack", ["pnpm", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "pipe",
  });
  db = new PrismaClient();
  repo = new PlatformRepository(db, "DEMO", null);
  worker = new WorkerRepository(repo, 1000);
  await db.$connect();
});
afterAll(async () => {
  await db.$disconnect();
  const admin = new PrismaClient({ datasourceUrl: originalUrl });
  await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.$disconnect();
  process.env.DATABASE_URL = originalUrl;
});
describe("real PostgreSQL transactional workflow", () => {
  it("parallel planning commands create one run; identical receipts replay and mismatched bodies conflict", async () => {
    const { t } = await fixture();
    const c = command(t.id);
    const results = await Promise.all([
      repo.start(c, "PLAN"),
      repo.start(c, "PLAN"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.agentRun.count({ where: { taskId: t.id } })).toBe(1);
    await expect(
      repo.start({ ...c, body: { unexpected: true } }, "PLAN"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(repo.start(command(t.id), "PLAN")).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    const { t: other } = await fixture();
    await expect(
      repo.start({ ...c, resourceId: other.id }, "PLAN"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("different concurrent command keys also produce exactly one active logical run", async () => {
    const { t } = await fixture();
    const result = await Promise.allSettled([
      repo.start(command(t.id), "PLAN"),
      repo.start(command(t.id), "PLAN"),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.agentRun.count({ where: { taskId: t.id } })).toBe(1);
  });
  it("run, transition, event, outbox and receipt rollback together", async () => {
    const { t } = await fixture();
    await expect(
      repo.command(command(t.id), async (tx) => {
        await repo.queue(tx, t, "PLAN", "c", "operator");
        throw new Error("simulate crash before commit");
      }),
    ).rejects.toThrow();
    expect((await repo.detail(t.id)).status).toBe("DRAFT");
    expect(await db.agentRun.count({ where: { taskId: t.id } })).toBe(0);
    expect(await db.outboxMessage.count({ where: { taskId: t.id } })).toBe(0);
    expect(await db.commandReceipt.count({ where: { resourceId: t.id } })).toBe(
      0,
    );
    expect(
      await db.event.count({
        where: { taskId: t.id, type: "PLANNING_REQUESTED" },
      }),
    ).toBe(0);
  });
  it("immutable snapshots survive later source changes and DB rejects mutation", async () => {
    const f = await queued();
    const r = await db.agentRun.findUniqueOrThrow({
      where: { id: f.payload.agentRunId },
    });
    await db.task.update({
      where: { id: f.t.id },
      data: { description: "later edit" },
    });
    expect(
      (await db.agentRun.findUniqueOrThrow({ where: { id: r.id } }))
        .inputSnapshot,
    ).toEqual(r.inputSnapshot);
    await expect(
      db.agentRun.update({
        where: { id: r.id },
        data: { inputSnapshot: { changed: true } },
      }),
    ).rejects.toThrow();
  });
  it("duplicate delivery and duplicate completion produce one immutable plan, approval and event", async () => {
    const f = await completed();
    expect(await worker.claim(f.payload)).toBeNull();
    expect(await worker.complete(f.claim, f.result)).toBe(false);
    expect(await db.taskPlan.count({ where: { taskId: f.t.id } })).toBe(1);
    expect(await db.approval.count({ where: { taskId: f.t.id } })).toBe(1);
    expect(
      await db.event.count({ where: { taskId: f.t.id, type: "PLAN_CREATED" } }),
    ).toBe(1);
    await expect(
      db.taskPlan.update({
        where: { id: f.detail.currentPlanId! },
        data: { content: plan },
      }),
    ).rejects.toThrow();
    await expect(
      db.event.updateMany({
        where: { taskId: f.t.id },
        data: { type: "changed" },
      }),
    ).rejects.toThrow();
  });
  it("claims exclude duplicates; expired lease interrupts old attempt and fences its late result", async () => {
    const f = await queued();
    const old = await worker.claim(f.payload);
    expect(await worker.claim(f.payload)).toBeNull();
    await db.agentRun.update({
      where: { id: f.payload.agentRunId },
      data: { leaseUntil: new Date(0) },
    });
    const newer = await worker.claim(f.payload);
    expect(newer).not.toBeNull();
    const output = await provider.execute(productDefinition, newer!.input, {
      signal: new AbortController().signal,
      runId: f.payload.agentRunId,
    });
    expect(await worker.complete(old!, output)).toBe(false);
    expect(await worker.complete(newer!, output)).toBe(true);
    const attempts = await db.agentRunAttempt.findMany({
      where: { agentRunId: f.payload.agentRunId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts.map((a) => a.status)).toEqual(["INTERRUPTED", "SUCCEEDED"]);
    expect(attempts[0]!.estimatedCostUsd?.toString()).toBe("0");
  });
  it("crashes count against a maximum of three attempts", async () => {
    const f = await queued();
    for (let i = 0; i < 3; i++) {
      expect(await worker.claim(f.payload)).not.toBeNull();
      await db.agentRun.update({
        where: { id: f.payload.agentRunId },
        data: { leaseUntil: new Date(0) },
      });
    }
    expect(await worker.claim(f.payload)).toBeNull();
    expect((await repo.detail(f.t.id)).status).toBe("FAILED");
    expect(
      await db.agentRunAttempt.count({
        where: { agentRunId: f.payload.agentRunId, status: "INTERRUPTED" },
      }),
    ).toBe(3);
  });
  it("late cancellation results cannot publish a plan but known costs still count", async () => {
    const f = await queued();
    const c = await worker.claim(f.payload);
    await repo.cancel(f.t.id, "operator", "cancel-test");
    const paid = new WorkerRepository(repo, 1000, {
      model: "actual-model",
      version: "v1",
      input: "2",
      cached: "1",
      output: "4",
    });
    const output: AgentExecution<unknown> = {
      provider: "OPENAI",
      model: "actual-model",
      providerRequestId: "real-response",
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 },
      output: plan,
    };
    expect(await paid.complete(c!, output)).toBe(false);
    expect((await repo.detail(f.t.id)).status).toBe("CANCELLED");
    expect(await db.taskPlan.count({ where: { taskId: f.t.id } })).toBe(0);
    const a = await db.agentRunAttempt.findUniqueOrThrow({
      where: { id: c!.attemptId },
    });
    expect(a.status).toBe("CANCELLED");
    expect(a.estimatedCostUsd?.toFixed(8)).toBe("0.00022000");
    await paid.failure(c!, new ProviderError("CANCELLED", false));
    expect(
      (
        await db.agentRunAttempt.findUniqueOrThrow({
          where: { id: c!.attemptId },
        })
      ).estimatedCostUsd?.toFixed(8),
    ).toBe("0.00022000");
  });
  it("approve vs reject commits one decision; stale version and foreign plan conflict", async () => {
    const f = await completed();
    const other = await completed();
    const body = {
      planId: f.detail.currentPlanId!,
      expectedTaskVersion: f.detail.version,
    };
    await expect(
      repo.decide(
        command(f.approval.id, "APPROVE", {
          ...body,
          planId: other.detail.currentPlanId,
        }),
        "APPROVE",
        { ...body, planId: other.detail.currentPlanId! },
      ),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    await expect(
      repo.decide(
        command(f.approval.id, "APPROVE", { ...body, expectedTaskVersion: 0 }),
        "APPROVE",
        { ...body, expectedTaskVersion: 0 },
      ),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    const result = await Promise.allSettled(
      ["APPROVE", "REJECT"].map((a) =>
        repo.decide(
          command(f.approval.id, a, body),
          a as "APPROVE" | "REJECT",
          body,
        ),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.event.count({
        where: {
          taskId: f.t.id,
          type: { in: ["PLAN_APPROVED", "PLAN_REJECTED"] },
        },
      }),
    ).toBe(1);
    expect(await db.outboxMessage.count({ where: { taskId: f.t.id } })).toBe(1);
  });
  it("request changes preserves decisions, snapshots and plan history through the revision limit", async () => {
    let f = await completed();
    for (let v = 2; v <= 5; v++) {
      const body = {
        planId: f.detail.currentPlanId!,
        expectedTaskVersion: f.detail.version,
        comment: "Search archived notes by title",
      };
      const c = command(f.approval.id, "CHANGES", body);
      const result = (await repo.decide(c, "CHANGES", body)) as {
        runId: string;
      };
      expect(await repo.decide(c, "CHANGES", body)).toEqual(result);
      const payload = { ...f.payload, agentRunId: result.runId };
      const claim = await worker.claim(payload);
      expect(claim!.input.changeRequest).toBe(body.comment);
      expect(claim!.input.previousPlan).not.toBeNull();
      const output = await provider.execute(productDefinition, claim!.input, {
        signal: new AbortController().signal,
        runId: result.runId,
      });
      await worker.complete(claim!, output);
      const detail = await repo.detail(f.t.id);
      expect(detail.plans).toHaveLength(v);
      expect(
        detail.approvals.filter((a) => a.status === "CHANGES_REQUESTED"),
      ).toHaveLength(v - 1);
      await expect(
        repo.decide(command(f.approval.id, "APPROVE", body), "APPROVE", body),
      ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
      f = {
        ...f,
        payload,
        claim: claim!,
        result: output,
        detail,
        approval: detail.approvals.find((a) => a.status === "PENDING")!,
      };
    }
    const body = {
      planId: f.detail.currentPlanId!,
      expectedTaskVersion: f.detail.version,
      comment: "sixth",
    };
    await expect(
      repo.decide(command(f.approval.id, "CHANGES", body), "CHANGES", body),
    ).rejects.toMatchObject({ code: "PLAN_REVISION_LIMIT_REACHED" });
    expect(
      (await db.approval.findUniqueOrThrow({ where: { id: f.approval.id } }))
        .status,
    ).toBe("PENDING");
  });
  it("DB composite constraints reject cross-project pointers, plans, attempts, approvals and events", async () => {
    const a = await completed();
    const b = await queued();
    await expect(
      db.task.update({
        where: { id: b.t.id },
        data: { currentPlanId: a.detail.currentPlanId },
      }),
    ).rejects.toThrow();
    await expect(
      db.task.update({
        where: { id: a.t.id },
        data: { activeRunId: b.payload.agentRunId },
      }),
    ).rejects.toThrow();
    await expect(
      db.agentRunAttempt.create({
        data: {
          agentRunId: b.payload.agentRunId,
          projectId: a.p.id,
          attemptNumber: 1,
          ownerToken: randomUUID(),
          status: "RUNNING",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.approval.create({
        data: {
          projectId: b.p.id,
          taskId: b.t.id,
          targetPlanId: a.detail.currentPlanId!,
          type: "OTHER",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.event.create({
        data: {
          projectId: b.p.id,
          taskId: a.t.id,
          type: "BAD",
          actorType: "SYSTEM",
          correlationId: "x",
          payload: {},
        },
      }),
    ).rejects.toThrow();
    expect(await worker.claim({ ...b.payload, projectId: a.p.id })).toBeNull();
  });
  it.each(["PROVIDER_AUTH", "PROVIDER_REFUSAL", "INVALID_STRUCTURED_OUTPUT"])(
    "%s is terminal, accounted, has no approval and supports explicit new-run retry",
    async (code) => {
      const f = await queued();
      const c = await worker.claim(f.payload);
      await worker.failure(
        c!,
        new ProviderError(code, false, {
          provider: "OPENAI",
          model: "m",
          usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
          providerRequestId: "id",
        }),
      );
      expect((await repo.detail(f.t.id)).status).toBe("FAILED");
      expect(await db.approval.count({ where: { taskId: f.t.id } })).toBe(0);
      const result = (await repo.start(command(f.t.id, "RETRY"), "RETRY")) as {
        runId: string;
      };
      expect(result.runId).not.toBe(f.payload.agentRunId);
      expect(
        await db.agentRunAttempt.count({
          where: { agentRunId: f.payload.agentRunId, status: "FAILED" },
        }),
      ).toBe(1);
    },
  );
  it("explicit retry preserves the failed change-request input snapshot", async () => {
    const f = await completed();
    const body = {
      planId: f.detail.currentPlanId!,
      expectedTaskVersion: f.detail.version,
      comment: "Search archived notes by title",
    };
    const change = (await repo.decide(
      command(f.approval.id, "CHANGES", body),
      "CHANGES",
      body,
    )) as { runId: string };
    const c = await worker.claim({ ...f.payload, agentRunId: change.runId });
    await worker.failure(c!, new ProviderError("PROVIDER_AUTH", false));
    const retry = (await repo.start(command(f.t.id, "RETRY"), "RETRY")) as {
      runId: string;
    };
    const r = await db.agentRun.findUniqueOrThrow({
      where: { id: retry.runId },
    });
    expect(r.inputSnapshot).toEqual({ ...c!.input, runId: retry.runId });
  });
  it("transient failures retry only three times with persisted delay", async () => {
    const f = await queued();
    for (let n = 1; n <= 3; n++) {
      const c = await worker.claim(f.payload);
      await worker.failure(c!, new ProviderError("PROVIDER_RATE_LIMIT", true));
      const r = await db.agentRun.findUniqueOrThrow({
        where: { id: f.payload.agentRunId },
      });
      expect(r.attemptCount).toBe(n);
      if (n < 3) {
        expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        expect(await worker.claim(f.payload)).toBeNull();
        await db.agentRun.update({
          where: { id: r.id },
          data: { nextAttemptAt: new Date(0) },
        });
      }
    }
    expect((await repo.detail(f.t.id)).status).toBe("FAILED");
  });
  it("processor enforces timeout and prevents non-cooperative late results from publishing", async () => {
    const f = await queued();
    let resolve!: (v: AgentExecution<unknown>) => void;
    const fake = {
      execute: () =>
        new Promise<AgentExecution<unknown>>((r) => {
          resolve = r;
        }),
    } as unknown as AgentProvider;
    await processPlanning(f.payload, worker, fake, 40);
    expect(
      (
        await db.agentRunAttempt.findFirstOrThrow({
          where: { agentRunId: f.payload.agentRunId },
        })
      ).errorCode,
    ).toBe("PROVIDER_TIMEOUT");
    resolve({
      provider: "DEMO",
      model: null,
      output: plan,
      providerRequestId: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.taskPlan.count({ where: { taskId: f.t.id } })).toBe(0);
  });
});
describe("real Redis outbox and global queue behavior", () => {
  it("outbox survives unavailable Redis and replays after delivery-before-ack crash", async () => {
    const f = await queued();
    const connection = redisConnection(process.env.REDIS_URL!);
    const queue = planningQueue(process.env.REDIS_URL!, schema);
    const d = new Dispatcher(worker, queue);
    try {
      const failQueue = planningQueue(
        process.env.REDIS_URL!,
        schema + "_offline",
      );
      await failQueue.waitUntilReady();
      await failQueue.disconnect();
      const broken = new Dispatcher(worker, failQueue);
      try {
        await broken.tick();
      } finally {
        await failQueue.close();
      }
      const o = await db.outboxMessage.findFirstOrThrow({
        where: { agentRunId: f.payload.agentRunId },
      });
      expect(o.status).toBe("PENDING");
      expect(o.attempts).toBeGreaterThan(0);
      await d.deliver(f.payload, "HIGH");
      await d.deliver(f.payload, "HIGH");
      expect(await queue.getJob(jobId(f.payload.agentRunId))).not.toBeNull();
      await db.outboxMessage.update({
        where: { id: o.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await d.tick();
      expect(
        (await db.outboxMessage.findUniqueOrThrow({ where: { id: o.id } }))
          .status,
      ).toBe("DISPATCHED");
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  });
  it("global concurrency is one across two workers and completed delivery can recover a stale DB lease", async () => {
    // Use a dedicated Redis DB for this test so no developer worker can consume its jobs.
    const redisUrl = new URL(process.env.REDIS_URL!);
    redisUrl.pathname = "/14";
    const url = redisUrl.toString();
    const queue = planningQueue(url, schema);
    await queue.setGlobalConcurrency(1);
    const d = new Dispatcher(worker, queue);
    let active = 0,
      maxActive = 0;
    const fn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
    };
    const c1 = redisConnection(url),
      c2 = redisConnection(url);
    const w1 = new Worker("planning", fn, {
        connection: c1,
        prefix: schema,
        concurrency: 2,
      }),
      w2 = new Worker("planning", fn, {
        connection: c2,
        prefix: schema,
        concurrency: 2,
      });
    const a = await queued(),
      b = await queued();
    try {
      await d.deliver(a.payload, "HIGH");
      await d.deliver(b.payload, "HIGH");
      await until(
        async () =>
          (await queue.getJob(jobId(a.payload.agentRunId)))?.isCompleted() ??
          false,
      );
      await until(
        async () =>
          (await queue.getJob(jobId(b.payload.agentRunId)))?.isCompleted() ??
          false,
      );
      expect(maxActive).toBe(1);
      await w1.close();
      await w2.close();
      const old = await worker.claim(a.payload);
      await db.agentRun.update({
        where: { id: a.payload.agentRunId },
        data: { leaseUntil: new Date(0) },
      });
      await d.deliver(a.payload, "HIGH");
      const c3 = redisConnection(url);
      const w3 = new Worker(
        "planning",
        (job) => processPlanning(job.data, worker, provider, 2000),
        { connection: c3, prefix: schema },
      );
      try {
        await until(
          async () =>
            (await repo.detail(a.t.id)).status === "WAITING_PLAN_APPROVAL",
        );
        expect(
          (
            await db.agentRunAttempt.findUniqueOrThrow({
              where: { id: old!.attemptId },
            })
          ).status,
        ).toBe("INTERRUPTED");
      } finally {
        await w3.close();
        await c3.quit();
      }
    } finally {
      await w1.close();
      await w2.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await c1.quit();
      await c2.quit();
    }
  });
});
describe("real process crash recovery", () => {
  it("SIGKILL during provider execution is recovered by a new worker with an interrupted attempt", async () => {
    const f = await queued();
    const prefix = schema + "_crash";
    const url = process.env.REDIS_URL!;
    const queue = planningQueue(url, prefix);
    await queue.setGlobalConcurrency(1);
    const dispatcher = new Dispatcher(worker, queue);
    const child = fork("tests/helpers/crash-worker.ts", [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, TEST_QUEUE_PREFIX: prefix },
      silent: true,
    });
    try {
      await once(child, "message");
      await dispatcher.deliver(f.payload, "HIGH");
      await until(
        async () =>
          (await db.agentRunAttempt.count({
            where: { agentRunId: f.payload.agentRunId, status: "RUNNING" },
          })) === 1,
      );
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      const connection = redisConnection(url);
      const restarted = new Worker(
        "planning",
        (job) => processPlanning(job.data, worker, provider, 2000),
        {
          connection,
          prefix,
          lockDuration: 500,
          stalledInterval: 500,
          maxStalledCount: 3,
        },
      );
      const timer = setInterval(() => void dispatcher.tick(), 100);
      try {
        await until(
          async () =>
            (await repo.detail(f.t.id)).status === "WAITING_PLAN_APPROVAL",
          10000,
        );
        const attempts = await db.agentRunAttempt.findMany({
          where: { agentRunId: f.payload.agentRunId },
          orderBy: { attemptNumber: "asc" },
        });
        expect(attempts.map((a) => a.status)).toEqual([
          "INTERRUPTED",
          "SUCCEEDED",
        ]);
        expect(attempts[0]!.inputTokens).toBeNull();
        expect(await db.taskPlan.count({ where: { taskId: f.t.id } })).toBe(1);
      } finally {
        clearInterval(timer);
        await restarted.close();
        await connection.quit();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
describe("HTTP session, input, origin and command boundaries", () => {
  it("requires session/CSRF, creates real resources, exposes matching OpenAPI, and sanitizes errors", async () => {
    const oldSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = randomUUID() + randomUUID();
    const runtime = await createApi();
    await runtime.app.listen(0, "127.0.0.1");
    const address = runtime.app.getHttpServer().address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const origin = process.env.WEB_ORIGIN!;
    try {
      expect((await fetch(base + "/projects")).status).toBe(401);
      expect((await fetch(base + "/health/ready")).status).toBe(200);
      const noOrigin = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: process.env.OPERATOR_PASSWORD }),
      });
      expect(noOrigin.status).toBe(403);
      const login = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ password: process.env.OPERATOR_PASSWORD }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const { csrfToken } = (await login.json()) as { csrfToken: string };
      const headers = {
        Origin: origin,
        Cookie: cookie.split(";")[0]!,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      };
      const badCsrf = await fetch(base + "/projects", {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": "bad" },
        body: JSON.stringify(project),
      });
      expect(badCsrf.status).toBe(403);
      const invalid = await fetch(base + "/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...project, secret: "should-not-be-echoed" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).not.toContain("should-not-be-echoed");
      const p = await fetch(base + "/projects", {
        method: "POST",
        headers,
        body: JSON.stringify(project),
      });
      expect(p.status).toBe(201);
      const pbody = (await p.json()) as { id: string };
      const t = await fetch(base + `/projects/${pbody.id}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify(task),
      });
      expect(t.status).toBe(201);
      const tbody = (await t.json()) as { id: string };
      expect(
        (await fetch(base + "/workspace-sources", { headers })).status,
      ).toBe(200);
      expect(
        (await fetch(base + `/tasks/${tbody.id}/development`, { headers }))
          .status,
      ).toBe(200);
      const noM2Csrf = await fetch(base + `/tasks/${tbody.id}/develop`, {
        method: "POST",
        headers: {
          ...headers,
          "X-CSRF-Token": "bad",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          approvedPlanId: randomUUID(),
          expectedTaskVersion: 1,
          sourceId: "sample-todo-v1",
        }),
      });
      expect(noM2Csrf.status).toBe(403);
      const invalidM2 = await fetch(base + `/tasks/${tbody.id}/develop`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          approvedPlanId: randomUUID(),
          expectedTaskVersion: 1,
          sourceId: "sample-todo-v1",
          status: "DONE",
        }),
      });
      expect(invalidM2.status).toBe(400);
      expect(
        (
          await fetch(base + `/tasks/${tbody.id}/plan`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(400);
      const start = await fetch(base + `/tasks/${tbody.id}/plan`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: "{}",
      });
      expect(start.status).toBe(202);
      expect(
        (await fetch(base + "/projects?limit=101", { headers })).status,
      ).toBe(400);
      expect(
        (await fetch(base + "/tasks/" + randomUUID(), { headers })).status,
      ).toBe(404);
      const spec = await fetch(base + "/openapi.json", { headers });
      expect(spec.status).toBe(200);
      const openapi = await spec.json();
      expect(openapi.openapi).toBe("3.1.0");
      expect(openapi.paths).toHaveProperty("/tasks/{id}/develop");
      expect(openapi.paths).toHaveProperty("/artifacts/{id}/download");
      const logout = await fetch(base + "/auth/logout", {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(logout.status).toBe(200);
      expect((await fetch(base + "/projects", { headers })).status).toBe(401);
      for (let i = 0; i < 9; i++)
        expect(
          (
            await fetch(base + "/auth/login", {
              method: "POST",
              headers: { Origin: origin, "Content-Type": "application/json" },
              body: JSON.stringify({ password: "wrong" }),
            })
          ).status,
        ).toBe(401);
      expect(
        (
          await fetch(base + "/auth/login", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ password: "wrong" }),
          })
        ).status,
      ).toBe(429);
    } finally {
      await runtime.close();
      process.env.SESSION_SECRET = oldSecret;
    }
  });
});
