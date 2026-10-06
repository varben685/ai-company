import { config as dotenv } from "dotenv";
dotenv({ quiet: true });
dotenv({ path: ".env.worker", quiet: true });
import { randomUUID } from "node:crypto";
import {
  PrismaClient,
  PlatformRepository,
  WorkerRepository,
} from "@company/database";
import { OpenAIProductProvider } from "@company/agents";
import { pricingFromEnv } from "@company/observability";
import { processPlanning } from "../apps/worker/src/processor";
async function smoke() {
  if (!process.env.OPENAI_API_KEY) {
    console.log(
      "LIVE_VALIDATION_PENDING: OPENAI_API_KEY is absent from the authorized worker environment. No live request was made.",
    );
    process.exitCode = 2;
    return;
  }
  const model = process.env.OPENAI_PRODUCT_MODEL;
  if (!model) throw new Error("OPENAI_PRODUCT_MODEL is required");
  const db = new PrismaClient();
  const repo = new PlatformRepository(db, "OPENAI", model);
  try {
    const p = await repo.createProject(
      {
        name: "LIVE Product Agent acceptance",
        description: "Explicitly identified single live M1 smoke test",
        context: {
          product:
            "Notes have title and content and belong to the signed-in user.",
          architecture:
            "TypeScript, NestJS REST API, Next.js UI, PostgreSQL. Controllers have no business logic.",
          codingStandards: "Services use repositories.",
          testing: "New endpoints require integration tests.",
          security: "Every note operation enforces ownership.",
          decisions: "No repository routes or files were supplied.",
        },
      },
      "operator",
      randomUUID(),
    );
    const t = await repo.createTask(
      p.id,
      {
        title: "Archive and restore notes",
        description:
          "Archive my notes, hide archived notes from the default list, show them in a separate archived list and restore them. Define repeated archive/restore behavior and owner checks.",
        priority: "NORMAL",
      },
      "operator",
      randomUUID(),
    );
    const result = (await repo.start(
      {
        resourceId: t.id,
        operation: "PLAN",
        body: {},
        key: randomUUID(),
        actorId: "operator",
        correlationId: randomUUID(),
      },
      "PLAN",
    )) as { runId: string };
    await processPlanning(
      { projectId: p.id, taskId: t.id, agentRunId: result.runId },
      new WorkerRepository(repo, 30000, pricingFromEnv()),
      new OpenAIProductProvider(process.env.OPENAI_API_KEY, model),
    );
    const detail = await repo.detail(t.id);
    const runs = await repo.runs(t.id);
    const a = runs[0]?.attempts[0];
    if (
      detail.status !== "WAITING_PLAN_APPROVAL" ||
      !a?.model ||
      a.inputTokens === null ||
      a.outputTokens === null
    )
      throw new Error(
        "LIVE_VALIDATION_FAILED: inspect the persisted run history",
      );
    console.log(
      JSON.stringify({
        result: "LIVE_VALIDATION_PASSED",
        taskId: t.id,
        runId: result.runId,
        model: a.model,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cachedInputTokens: a.cachedInputTokens,
        estimatedCostUsd: a.estimatedCostUsd,
        approval: "PENDING — human review required",
      }),
    );
  } finally {
    await db.$disconnect();
  }
}
void smoke().catch(() => {
  console.error(
    "LIVE_VALIDATION_FAILED: inspect local run history. Provider details are not logged.",
  );
  process.exitCode = 1;
});
