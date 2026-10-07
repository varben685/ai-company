import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { priorityOrder, type JobPayload } from "@company/contracts";
import { backoff } from "@company/workflow";
import type { WorkerRepository } from "@company/database";
import type { M2WorkerRepository, ValidationPayload } from "@company/database";
export function redisConnection(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
export const jobId = (id: string) => `planning-${id}`;
export function stageQueue<T = unknown>(
  name: "planning" | "development" | "validation" | "review",
  url: string,
  prefix = "company-m1",
) {
  const u = new URL(url);
  return new Queue<T>(name, {
    prefix,
    connection: {
      host: u.hostname,
      port: Number(u.port || 6379),
      db: Number(u.pathname.slice(1) || 0),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    },
  });
}
export function planningQueue(url: string, prefix = "company-m1") {
  return stageQueue<JobPayload>("planning", url, prefix);
}
export class Dispatcher {
  private running = false;
  constructor(
    readonly repo: WorkerRepository,
    readonly queue: Queue<JobPayload>,
  ) {}
  async deliver(payload: JobPayload, priority: string) {
    const id = jobId(payload.agentRunId);
    const existing = await this.queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") await existing.remove();
      else return;
    }
    await this.queue.add("plan", payload, {
      jobId: id,
      priority: priorityOrder[priority as keyof typeof priorityOrder],
      attempts: 1,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 86400 },
    });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const o of await this.repo.pending()) {
        try {
          await this.deliver(
            {
              projectId: o.projectId,
              taskId: o.taskId,
              agentRunId: o.agentRunId!,
            },
            o.run!.task.priority,
          );
          await this.repo.db.outboxMessage.update({
            where: { id: o.id },
            data: {
              status: "DISPATCHED",
              attempts: { increment: 1 },
              dispatchedAt: new Date(),
            },
          });
        } catch {
          await this.repo.db.outboxMessage.update({
            where: { id: o.id },
            data: {
              attempts: { increment: 1 },
              nextAttemptAt: new Date(Date.now() + backoff(o.attempts + 1)),
            },
          });
        }
      }
      // Reconciliation also handles lost Redis data, stalled-job exhaustion and a crash after enqueue.
      for (const r of await this.repo.recoverable())
        try {
          await this.deliver(
            { projectId: r.projectId, taskId: r.taskId, agentRunId: r.id },
            r.task.priority,
          );
        } catch {
          /* DB remains authoritative; next tick retries. */
        }
    } finally {
      this.running = false;
    }
  }
}
export class M2Dispatcher {
  private running = false;
  constructor(
    readonly repo: M2WorkerRepository,
    readonly queues: {
      development: Queue<JobPayload>;
      validation: Queue<ValidationPayload>;
      review: Queue<JobPayload>;
    },
  ) {}
  private async deliver(
    kind: "DEVELOPMENT_REQUESTED" | "VALIDATION_REQUESTED" | "REVIEW_REQUESTED",
    payload: JobPayload | ValidationPayload,
    priority = 3,
  ) {
    const name =
      kind === "DEVELOPMENT_REQUESTED"
        ? "development"
        : kind === "VALIDATION_REQUESTED"
          ? "validation"
          : "review";
    const queue = this.queues[name] as Queue<JobPayload | ValidationPayload>;
    const id = `${name}-${"agentRunId" in payload ? payload.agentRunId : payload.validationRunId}`;
    const existing = await queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") await existing.remove();
      else return;
    }
    await queue.add(name, payload, {
      jobId: id,
      priority,
      attempts: 1,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 86400 },
    });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const o of await this.repo.pending()) {
        const kind = o.kind as
          "DEVELOPMENT_REQUESTED" | "VALIDATION_REQUESTED" | "REVIEW_REQUESTED";
        const payload = o.agentRunId
          ? {
              projectId: o.projectId,
              taskId: o.taskId,
              agentRunId: o.agentRunId,
            }
          : {
              projectId: o.projectId,
              taskId: o.taskId,
              validationRunId: o.validationRunId!,
            };
        try {
          await this.deliver(kind, payload);
          await this.repo.db.outboxMessage.update({
            where: { id: o.id },
            data: {
              status: "DISPATCHED",
              attempts: { increment: 1 },
              dispatchedAt: new Date(),
            },
          });
        } catch {
          await this.repo.db.outboxMessage.update({
            where: { id: o.id },
            data: {
              attempts: { increment: 1 },
              nextAttemptAt: new Date(Date.now() + backoff(o.attempts + 1)),
            },
          });
        }
      }
      for (const r of await this.repo.recoverableAgents())
        try {
          await this.deliver(
            r.agentType === "DEVELOPER"
              ? "DEVELOPMENT_REQUESTED"
              : "REVIEW_REQUESTED",
            { projectId: r.projectId, taskId: r.taskId, agentRunId: r.id },
          );
        } catch {}
      for (const v of await this.repo.recoverableValidation())
        try {
          if (
            await this.repo.db.outboxMessage.findFirst({
              where: { validationRunId: v.id, status: "DISPATCHED" },
            })
          )
            await this.deliver("VALIDATION_REQUESTED", {
              projectId: v.projectId,
              taskId: v.taskId,
              validationRunId: v.id,
            });
        } catch {}
    } finally {
      this.running = false;
    }
  }
}
