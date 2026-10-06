import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { priorityOrder, type JobPayload } from "@company/contracts";
import { backoff } from "@company/workflow";
import type { WorkerRepository } from "@company/database";
export function redisConnection(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
export const jobId = (id: string) => `planning-${id}`;
export function planningQueue(url: string, prefix = "company-m1") {
  const u = new URL(url);
  return new Queue<JobPayload>("planning", {
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
              agentRunId: o.agentRunId,
            },
            o.run.task.priority,
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
