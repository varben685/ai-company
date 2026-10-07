import { config as dotenv } from "dotenv";
dotenv({ quiet: true });
dotenv({ path: ".env.worker", quiet: true });
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  PrismaClient,
  PlatformRepository,
  M2Repository,
  WorkerRepository,
} from "@company/database";
import { StartDevelopment } from "@company/contracts";
import { OpenAIProductProvider } from "@company/agents";
import { pricingFromEnv } from "@company/observability";
import { processPlanning } from "../apps/worker/src/processor";

async function preparePlan() {
  const db = new PrismaClient();
  try {
    await db.$connect();
    const model = process.env.OPENAI_PRODUCT_MODEL ?? "gpt-4.1-mini";
    const repo = new PlatformRepository(db, "OPENAI", model);
    const existing = await db.task.findFirst({
      where: {
        title: "Complete todos",
        status: {
          in: [
            "WAITING_PLAN_APPROVAL",
            "QUEUED_FOR_PLANNING",
            "PLANNING",
            "PLAN_APPROVED",
          ],
        },
        project: {
          name: "LIVE M2 sample Todo",
          workspaceSourceId: "sample-todo-v1",
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      console.log(
        JSON.stringify({
          result: "LIVE_M2_PLAN_REUSED",
          taskId: existing.id,
          status: existing.status,
          planId: existing.currentPlanId,
          humanPlanApprovalRequired: existing.status !== "PLAN_APPROVED",
        }),
      );
      return;
    }
    const project = await repo.createProject(
      {
        name: "LIVE M2 sample Todo",
        description:
          "Human-reviewed Product plan for the versioned M2 coding loop",
        workspaceSourceId: "sample-todo-v1",
        context: {
          product:
            "Small todo store with createTodo and listTodos. Add completion and optional filtering.",
          architecture: "JavaScript ESM on Node 24; no dependencies.",
          codingStandards:
            "Keep functions small and preserve existing exports.",
          testing:
            "Node built-in test runner and fixed platform acceptance suite.",
          security: "No network or secrets in the workspace.",
          decisions: "Use the versioned sample-todo-v1 source only.",
        },
      },
      "operator",
      randomUUID(),
    );
    const task = await repo.createTask(
      project.id,
      {
        title: "Complete todos",
        description:
          "Implement setCompleted(id, completed), reject unknown IDs, and let listTodos hide completed todos when includeCompleted is false. Preserve create and list behavior and avoid exposing stored objects to external mutation.",
        priority: "NORMAL",
      },
      "operator",
      randomUUID(),
    );
    const started = (await repo.start(
      {
        resourceId: task.id,
        operation: "PLAN",
        body: {},
        key: randomUUID(),
        actorId: "operator",
        correlationId: randomUUID(),
      },
      "PLAN",
    )) as { runId: string };
    await processPlanning(
      { projectId: project.id, taskId: task.id, agentRunId: started.runId },
      new WorkerRepository(repo, 30000, pricingFromEnv()),
      new OpenAIProductProvider(process.env.OPENAI_API_KEY!, model),
    );
    const current = await repo.detail(task.id);
    console.log(
      JSON.stringify({
        result:
          current.status === "WAITING_PLAN_APPROVAL"
            ? "LIVE_M2_PLAN_APPROVAL_PENDING"
            : "LIVE_M2_PLAN_FAILED",
        taskId: task.id,
        productRunId: started.runId,
        planId: current.currentPlanId,
        humanPlanApprovalRequired: true,
      }),
    );
    if (current.status !== "WAITING_PLAN_APPROVAL") process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const taskId = process.env.M2_LIVE_TASK_ID;
  if (process.env.PROVIDER !== "OPENAI" || !process.env.OPENAI_API_KEY) {
    console.log(
      "LIVE_M2_VALIDATION_PENDING: OPENAI worker mode and a local worker key are required.",
    );
    process.exit(2);
  }
  if (!taskId) {
    await preparePlan();
    return;
  }
  const db = new PrismaClient();
  const worker = spawn("corepack", ["pnpm", "dev:worker"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
  });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await db.$connect();
    const repo = new PlatformRepository(
      db,
      "OPENAI",
      process.env.OPENAI_PRODUCT_MODEL ?? "gpt-4.1-mini",
    );
    const m2 = new M2Repository(repo, undefined, {
      developer: process.env.OPENAI_DEVELOPER_MODEL ?? "gpt-4.1-mini",
      reviewer: process.env.OPENAI_REVIEWER_MODEL ?? "gpt-4.1-mini",
    });
    const task = await repo.detail(taskId);
    const project = await db.project.findUniqueOrThrow({
      where: { id: task.projectId },
    });
    const approvedPlan = task.plans.find((p) => p.id === task.approvedPlanId);
    const hasSampleContract =
      /listTodos\(\{\s*includeCompleted:\s*false\s*\}\)/.test(
        JSON.stringify(approvedPlan?.content ?? {}),
      );
    if (
      task.status !== "PLAN_APPROVED" ||
      !task.approvedPlanId ||
      task.developmentSessionId ||
      project.workspaceSourceId !== "sample-todo-v1" ||
      !hasSampleContract
    ) {
      console.log(
        "LIVE_M2_VALIDATION_PENDING: The chosen task needs a current human-approved sample plan specifying listTodos({ includeCompleted: false }) and no existing development session.",
      );
      process.exitCode = 2;
    } else {
      const body = StartDevelopment.parse({
        approvedPlanId: task.approvedPlanId,
        expectedTaskVersion: task.version,
        sourceId: "sample-todo-v1",
      });
      const started = (await m2.start(
        {
          resourceId: task.id,
          operation: "START_DEVELOPMENT",
          body,
          key: randomUUID(),
          actorId: "operator",
          correlationId: randomUUID(),
        },
        body,
      )) as { runId: string };
      console.log(
        `LIVE_M2_STARTED task=${task.id} developerRun=${started.runId}`,
      );
      const deadline = Date.now() + 15 * 60_000;
      let result = "TIMEOUT";
      while (Date.now() < deadline) {
        const now = await repo.detail(task.id);
        if (
          [
            "WAITING_FINAL_APPROVAL",
            "HUMAN_REVIEW_REQUIRED",
            "BLOCKED",
            "FAILED",
            "CANCELLED",
          ].includes(now.status)
        ) {
          result = now.status;
          break;
        }
        await pause(2000);
      }
      const runs = await repo.runs(task.id);
      const view = await m2.view(task.id);
      const developer = runs.filter((r) => r.agentType === "DEVELOPER");
      const reviewer = runs.filter((r) => r.agentType === "REVIEWER");
      const passed =
        view?.validations.some((v) => v.status === "PASS") ?? false;
      const usedTools = developer.some((r) =>
        r.attempts.some((a) => a.toolExecutions.length > 0),
      );
      console.log(
        JSON.stringify({
          result,
          taskId: task.id,
          developerRuns: developer.map((r) => ({
            id: r.id,
            status: r.status,
            attempts: r.attemptCount,
          })),
          reviewerRuns: reviewer.map((r) => ({
            id: r.id,
            status: r.status,
            attempts: r.attemptCount,
          })),
          validationPass: passed,
          developerUsedTools: usedTools,
          finalHumanDecisionPending: result === "WAITING_FINAL_APPROVAL",
        }),
      );
      if (
        result !== "WAITING_FINAL_APPROVAL" ||
        !passed ||
        !usedTools ||
        !reviewer.some((r) => r.status === "SUCCEEDED")
      )
        process.exitCode = 1;
    }
  } catch (e) {
    console.log(
      `LIVE_M2_VALIDATION_PENDING: ${(e as { code?: string }).code ?? "LOCAL_SMOKE_FAILED"}`,
    );
    process.exitCode = 2;
  } finally {
    if (worker.pid)
      try {
        process.kill(-worker.pid, "SIGTERM");
      } catch {}
    await db.$disconnect();
  }
}
void main().catch(() => {
  console.log("LIVE_M2_VALIDATION_PENDING: PREPARATION_FAILED");
  process.exitCode = 2;
});
