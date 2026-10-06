import { Worker } from "bullmq";
import {
  PrismaClient,
  PlatformRepository,
  WorkerRepository,
} from "@company/database";
import { redisConnection } from "@company/integrations";
import type { AgentProvider } from "@company/agents";
import { processPlanning } from "../../apps/worker/src/processor";
const db = new PrismaClient();
const repo = new WorkerRepository(
  new PlatformRepository(db, "DEMO", null),
  1000,
);
const hung = { execute: () => new Promise(() => undefined) } as AgentProvider;
const connection = redisConnection(process.env.REDIS_URL!);
const worker = new Worker(
  "planning",
  (job) => processPlanning(job.data, repo, hung, 120000),
  {
    connection,
    prefix: process.env.TEST_QUEUE_PREFIX!,
    lockDuration: 500,
    stalledInterval: 500,
  },
);
worker.on("error", () => undefined);
void worker.waitUntilReady().then(() => process.send?.("ready"));
