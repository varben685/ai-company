import { PrismaClient, Prisma, type Task } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CreateProject,
  CreateTask,
  ProductInput,
  priorityOrder,
  type ProductPlan,
  type Decision,
} from "@company/contracts";
import {
  checkApproval,
  DomainError,
  transition,
  type Action,
} from "@company/workflow";
export { PrismaClient, Prisma };
export type Tx = Prisma.TransactionClient;
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
export async function event(
  tx: Tx,
  t: { projectId: string; id?: string },
  type: string,
  correlationId: string,
  actorId: string | null = null,
  agentRunId: string | null = null,
  payload: unknown = {},
) {
  await tx.event.create({
    data: {
      projectId: t.projectId,
      taskId: t.id,
      agentRunId,
      type,
      actorType: actorId ? "HUMAN" : "SYSTEM",
      actorId,
      correlationId,
      payload: json(payload),
    },
  });
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export interface Command {
  operation: string;
  resourceId: string;
  actorId: string;
  key: string;
  body: unknown;
  correlationId: string;
}
export class PlatformRepository {
  constructor(
    public readonly db: PrismaClient,
    readonly provider: "DEMO" | "OPENAI",
    readonly model: string | null,
  ) {}
  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(fn, { timeout: 10000 });
  }
  async command(c: Command, fn: (tx: Tx) => Promise<unknown>) {
    if (!/^[\w-]{8,128}$/.test(c.key))
      throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    return this.transaction(async (tx) => {
      await lock(tx, `command:${c.operation}:${c.actorId}:${c.key}`);
      const hash = createHash("sha256")
        .update(canonical({ resourceId: c.resourceId, body: c.body }))
        .digest("hex");
      const receipt = await tx.commandReceipt.findUnique({
        where: {
          operation_actorId_key: {
            operation: c.operation,
            actorId: c.actorId,
            key: c.key,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== hash)
          throw new DomainError(
            "IDEMPOTENCY_KEY_REUSED",
            409,
            "This key was already used for a different request.",
          );
        return receipt.response;
      }
      const response = json(await fn(tx));
      await tx.commandReceipt.create({
        data: {
          operation: c.operation,
          actorId: c.actorId,
          key: c.key,
          resourceId: c.resourceId,
          requestHash: hash,
          response,
        },
      });
      return response;
    });
  }
  async task(tx: Tx, id: string) {
    await lock(tx, `task:${id}`);
    const t = await tx.task.findUnique({ where: { id } });
    if (!t) throw new DomainError("TASK_NOT_FOUND", 404);
    return t;
  }
  async queue(
    tx: Tx,
    t: Task,
    action: Action,
    correlationId: string,
    actorId: string,
    changeRequest: string | null = null,
  ) {
    const status = transition(t.status, action);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: t.projectId },
    });
    const previous = t.currentPlanId
      ? await tx.taskPlan.findUniqueOrThrow({ where: { id: t.currentPlanId } })
      : null;
    if (previous && previous.versionNumber >= 5)
      throw new DomainError("PLAN_REVISION_LIMIT_REACHED");
    const runId = randomUUID();
    const failed =
      action === "RETRY"
        ? await tx.agentRun.findFirst({
            where: { taskId: t.id, status: "FAILED" },
            orderBy: { createdAt: "desc" },
          })
        : null;
    const snapshot = ProductInput.parse(
      failed
        ? { ...ProductInput.parse(failed.inputSnapshot), runId }
        : {
            projectId: t.projectId,
            taskId: t.id,
            runId,
            task: {
              title: t.title,
              description: t.description,
              priority: t.priority,
            },
            project: {
              name: project.name,
              description: project.description,
              context: project.context,
              contextVersion: project.contextVersion,
            },
            previousPlan: previous?.content ?? null,
            changeRequest,
          },
    );
    await tx.agentRun.create({
      data: {
        id: runId,
        projectId: t.projectId,
        taskId: t.id,
        provider: this.provider,
        model: this.model,
        promptVersion: "product-v1",
        inputSnapshot: json(snapshot),
      },
    });
    await tx.task.update({
      where: { id: t.id },
      data: {
        status,
        version: { increment: 1 },
        activeRunId: runId,
        failureCode: null,
      },
    });
    const payload = { projectId: t.projectId, taskId: t.id, agentRunId: runId };
    await tx.outboxMessage.create({ data: { ...payload, payload } });
    await event(tx, t, "PLANNING_REQUESTED", correlationId, actorId, runId, {
      action,
    });
    return { runId, taskId: t.id, status, version: t.version + 1 };
  }
  start(c: Command, action: "PLAN" | "RETRY") {
    return this.command(c, async (tx) =>
      this.queue(
        tx,
        await this.task(tx, c.resourceId),
        action,
        c.correlationId,
        c.actorId,
      ),
    );
  }
  decide(
    c: Command,
    action: "APPROVE" | "CHANGES" | "REJECT",
    body: z.infer<typeof Decision>,
  ) {
    return this.command(c, async (tx) => {
      const initial = await tx.approval.findUnique({
        where: { id: c.resourceId },
      });
      if (!initial) throw new DomainError("APPROVAL_NOT_FOUND", 404);
      const t = await this.task(tx, initial.taskId);
      const a = await tx.approval.findUniqueOrThrow({
        where: { id: initial.id },
      });
      checkApproval(t, body.planId, body.expectedTaskVersion);
      if (
        a.status !== "PENDING" ||
        a.targetPlanId !== body.planId ||
        a.projectId !== t.projectId
      )
        throw new DomainError("STALE_APPROVAL");
      const status = {
        APPROVE: "APPROVED",
        CHANGES: "CHANGES_REQUESTED",
        REJECT: "REJECTED",
      }[action];
      await tx.approval.update({
        where: { id: a.id },
        data: {
          status,
          decidedBy: c.actorId,
          decidedAt: new Date(),
          comment: body.comment ?? null,
        },
      });
      await event(tx, t, `PLAN_${status}`, c.correlationId, c.actorId, null, {
        planId: body.planId,
        approvalId: a.id,
      });
      if (action === "CHANGES")
        return this.queue(
          tx,
          t,
          "CHANGES",
          c.correlationId,
          c.actorId,
          body.comment ?? null,
        );
      const task = await tx.task.update({
        where: { id: t.id },
        data: {
          status: transition(t.status, action),
          version: { increment: 1 },
          ...(action === "APPROVE" ? { approvedPlanId: body.planId } : {}),
        },
      });
      return { taskId: t.id, status: task.status, version: task.version };
    });
  }
  cancel(id: string, actorId: string, correlationId: string) {
    return this.transaction(async (tx) => {
      const t = await this.task(tx, id);
      const status = transition(t.status, "CANCEL");
      if (t.activeRunId) {
        await tx.agentRun.updateMany({
          where: { id: t.activeRunId, status: { in: ["QUEUED", "RUNNING"] } },
          data: {
            status: "CANCELLED",
            finishedAt: new Date(),
            ownerToken: null,
            leaseUntil: null,
          },
        });
        await tx.agentRunAttempt.updateMany({
          where: { agentRunId: t.activeRunId, status: "RUNNING" },
          data: {
            status: "CANCELLED",
            finishedAt: new Date(),
            errorCode: "CANCELLED",
          },
        });
      }
      await tx.approval.updateMany({
        where: { taskId: id, status: "PENDING" },
        data: {
          status: "CANCELLED",
          decidedAt: new Date(),
          decidedBy: actorId,
        },
      });
      const task = await tx.task.update({
        where: { id },
        data: { status, version: { increment: 1 }, activeRunId: null },
      });
      await event(
        tx,
        t,
        "TASK_CANCELLED",
        correlationId,
        actorId,
        t.activeRunId,
      );
      return task;
    });
  }
  createProject(
    input: z.infer<typeof CreateProject>,
    actor: string,
    correlation: string,
  ) {
    return this.transaction(async (tx) => {
      const p = await tx.project.create({
        data: { ...input, context: json(input.context) },
      });
      await event(
        tx,
        { projectId: p.id },
        "PROJECT_CREATED",
        correlation,
        actor,
      );
      return p;
    });
  }
  createTask(
    projectId: string,
    input: z.infer<typeof CreateTask>,
    actor: string,
    correlation: string,
  ) {
    return this.transaction(async (tx) => {
      const p = await tx.project.findUnique({ where: { id: projectId } });
      if (!p) throw new DomainError("PROJECT_NOT_FOUND", 404);
      const t = await tx.task.create({
        data: {
          ...input,
          projectId,
          priorityRank: priorityOrder[input.priority],
        },
      });
      await event(tx, t, "TASK_CREATED", correlation, actor);
      return t;
    });
  }
  async project(id: string) {
    const p = await this.db.project.findUnique({ where: { id } });
    if (!p) throw new DomainError("PROJECT_NOT_FOUND", 404);
    return p;
  }
  async projects(page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.db.project.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.db.project.count(),
    ]);
    return { items, total, page, limit };
  }
  async tasks(projectId: string, page: number, limit: number, status?: string) {
    await this.project(projectId);
    const where = { projectId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.db.task.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ priorityRank: "asc" }, { createdAt: "asc" }],
      }),
      this.db.task.count({ where }),
    ]);
    return { items, total, page, limit };
  }
  async detail(id: string) {
    const t = await this.db.task.findUnique({
      where: { id },
      include: {
        plans: { orderBy: { versionNumber: "asc" } },
        approvals: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!t) throw new DomainError("TASK_NOT_FOUND", 404);
    return t;
  }
  async runs(taskId: string) {
    await this.detail(taskId);
    return this.db.agentRun.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        taskId: true,
        projectId: true,
        status: true,
        provider: true,
        model: true,
        promptVersion: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        failureCode: true,
        attemptCount: true,
        attempts: {
          orderBy: { attemptNumber: "asc" },
          select: {
            id: true,
            attemptNumber: true,
            status: true,
            model: true,
            startedAt: true,
            finishedAt: true,
            inputTokens: true,
            outputTokens: true,
            cachedInputTokens: true,
            estimatedCostUsd: true,
            pricingVersion: true,
            providerRequestId: true,
            errorCode: true,
          },
        },
      },
    });
  }
  async events(taskId: string, page: number, limit: number) {
    await this.detail(taskId);
    const [items, total] = await Promise.all([
      this.db.event.findMany({
        where: { taskId },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.db.event.count({ where: { taskId } }),
    ]);
    return { items, total, page, limit };
  }
  async dashboard() {
    const [
      projects,
      activeTasks,
      pendingApprovals,
      runs,
      cost,
      unknownAttempts,
    ] = await Promise.all([
      this.db.project.count(),
      this.db.task.count({
        where: {
          status: {
            in: ["QUEUED_FOR_PLANNING", "PLANNING", "WAITING_PLAN_APPROVAL"],
          },
        },
      }),
      this.db.approval.count({ where: { status: "PENDING" } }),
      this.db.agentRun.count(),
      this.db.agentRunAttempt.aggregate({ _sum: { estimatedCostUsd: true } }),
      this.db.agentRunAttempt.count({ where: { estimatedCostUsd: null } }),
    ]);
    return {
      projects,
      activeTasks,
      pendingApprovals,
      runs,
      knownEstimatedCostUsd:
        cost._sum.estimatedCostUsd?.toFixed(8) ?? "0.00000000",
      currency: "USD",
      unknownAttempts,
    };
  }
}
export type SavedPlan = ProductPlan;

export * from "./worker-repository";
