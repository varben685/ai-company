import { config as dotenv } from "dotenv";
dotenv({ quiet: true });
dotenv({ path: ".env.worker", quiet: true });
import { Worker } from "bullmq";
import {
  PrismaClient,
  PlatformRepository,
  WorkerRepository,
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
} from "@company/integrations";
import { processPlanning } from "./processor";
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
  const dispatcher = new Dispatcher(repo, queue);
  const tick = () =>
    void dispatcher.tick().catch(() => safeLog("DISPATCH_ERROR"));
  const timer = setInterval(tick, 1000);
  tick();
  safeLog("WORKER_READY", { provider: env.PROVIDER });
  const stop = async () => {
    clearInterval(timer);
    await worker.close();
    await queue.close();
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
