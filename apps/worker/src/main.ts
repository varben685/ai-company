import { config as dotenv } from "dotenv";
dotenv({ quiet: true });
dotenv({ path: ".env.worker", quiet: true });
import { Worker } from "bullmq";
import {
  PrismaClient,
  PlatformRepository,
  WorkerRepository,
  M2WorkerRepository,
} from "@company/database";
import {
  config,
  WorkerEnv,
  pricingFromEnv,
  safeLog,
  ConfigurationError,
} from "@company/observability";
import { makeProvider } from "@company/agents";
import {
  planningQueue,
  redisConnection,
  Dispatcher,
  M2Dispatcher,
  stageQueue,
} from "@company/integrations";
import { processPlanning } from "./processor";
import {
  processDevelopment,
  processValidation,
  processReview,
} from "./m2-processors";
import { DockerWorkspaceBackend } from "@company/workspace";
import { reconcileWorkspaces } from "./m2-reconcile";
async function main() {
  const env = config(WorkerEnv);
  const db = new PrismaClient();
  await db.$connect();
  const repo = new WorkerRepository(
    new PlatformRepository(
      db,
      env.PROVIDER,
      env.PROVIDER === "OPENAI" ? env.OPENAI_PRODUCT_MODEL : null,
    ),
    env.LEASE_MS,
    pricingFromEnv(),
  );
  const queue = planningQueue(env.REDIS_URL, env.QUEUE_PREFIX);
  await queue.setGlobalConcurrency(1);
  const development = stageQueue<import("@company/contracts").JobPayload>(
    "development",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
  );
  const validation = stageQueue<import("@company/database").ValidationPayload>(
    "validation",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
  );
  const review = stageQueue<import("@company/contracts").JobPayload>(
    "review",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
  );
  await Promise.all([
    development.setGlobalConcurrency(1),
    validation.setGlobalConcurrency(1),
    review.setGlobalConcurrency(1),
  ]);
  const m2repo = new M2WorkerRepository(
    new PlatformRepository(
      db,
      env.PROVIDER,
      env.PROVIDER === "OPENAI" ? env.OPENAI_PRODUCT_MODEL : null,
    ),
    env.LEASE_MS,
    undefined,
    {
      developer: env.OPENAI_DEVELOPER_MODEL,
      reviewer: env.OPENAI_REVIEWER_MODEL,
    },
  );

  const connection = redisConnection(env.REDIS_URL);
  const worker = new Worker(
    "planning",
    (job) =>
      processPlanning(
        job.data,
        repo,
        (claim) =>
          makeProvider(
            claim.provider as "DEMO" | "OPENAI",
            env.OPENAI_API_KEY,
            claim.model ?? env.OPENAI_PRODUCT_MODEL,
          ),
        env.ATTEMPT_TIMEOUT_MS,
      ),
    {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: 1,
      lockDuration: 30000,
      maxStalledCount: 3,
    },
  );
  worker.on("error", () => safeLog("WORKER_QUEUE_ERROR"));
  worker.on("failed", (job) =>
    safeLog("JOB_FAILED", { jobId: job?.id ?? "unknown" }),
  );
  const workerOptions = {
    connection,
    prefix: env.QUEUE_PREFIX,
    concurrency: 1,
    lockDuration: 30000,
    maxStalledCount: 3,
  };
  const devWorker = new Worker(
    "development",
    (job) =>
      processDevelopment(job.data, m2repo, undefined, undefined, {
        key: env.OPENAI_API_KEY ?? "",
        model: env.OPENAI_DEVELOPER_MODEL,
        timeoutMs: env.ATTEMPT_TIMEOUT_MS,
      }),
    workerOptions,
  );
  const validationWorker = new Worker(
    "validation",
    (job) => processValidation(job.data, m2repo),
    workerOptions,
  );
  const reviewWorker = new Worker(
    "review",
    (job) =>
      processReview(job.data, m2repo, undefined, {
        key: env.OPENAI_API_KEY ?? "",
        model: env.OPENAI_REVIEWER_MODEL,
        timeoutMs: env.ATTEMPT_TIMEOUT_MS,
      }),
    workerOptions,
  );
  for (const w of [devWorker, validationWorker, reviewWorker])
    w.on("error", () => safeLog("WORKER_QUEUE_ERROR"));
  const dispatcher = new Dispatcher(repo, queue);
  const m2dispatcher = new M2Dispatcher(m2repo, {
    development,
    validation,
    review,
  });
  const tick = () =>
    void Promise.all([dispatcher.tick(), m2dispatcher.tick()]).catch(() =>
      safeLog("DISPATCH_ERROR"),
    );
  const timer = setInterval(tick, 1000);
  const backend = new DockerWorkspaceBackend();
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await reconcileWorkspaces(db, backend);
    } catch {
      safeLog("WORKSPACE_RECONCILE_ERROR");
    } finally {
      reconciling = false;
    }
  };
  await reconcile();
  tick();
  const reconcileTimer = setInterval(() => void reconcile(), 10000);
  safeLog("WORKER_READY", { provider: env.PROVIDER });
  const stop = async () => {
    clearInterval(timer);
    clearInterval(reconcileTimer);
    await Promise.all([
      worker.close(),
      devWorker.close(),
      validationWorker.close(),
      reviewWorker.close(),
    ]);
    await Promise.all([
      queue.close(),
      development.close(),
      validation.close(),
      review.close(),
    ]);
    await connection.quit();
    await db.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError)
    safeLog("WORKER_CONFIGURATION_ERROR", { message: error.message });
  else safeLog("WORKER_STARTUP_FAILED");
  process.exitCode = 1;
});
