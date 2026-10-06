import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ChangeDecision,
  CreateProject,
  CreateTask,
  Decision,
  EmptyCommand,
  Id,
  Pagination,
  openApi,
  outputContracts,
} from "@company/contracts";
import { PlatformRepository } from "@company/database";
import type { OperatorRequest } from "./security";
import type { Redis } from "ioredis";
// The same response schemas drive serialization and OpenAPI. Internal DB fields stay server-side.
async function wire<T>(route: string, result: Promise<T>) {
  return outputContracts[route]!.parse(
    JSON.parse(JSON.stringify(await result)),
  ) as z.infer<(typeof outputContracts)[string]>;
}
export class PlatformService {
  constructor(
    readonly repo: PlatformRepository,
    readonly redis: Redis,
  ) {}
  private command(
    req: OperatorRequest,
    id: string,
    operation: string,
    body: unknown,
  ) {
    return {
      resourceId: Id.parse(id),
      operation,
      body,
      key: String(req.headers["idempotency-key"] ?? ""),
      actorId: req.operator.id,
      correlationId: req.correlationId ?? randomUUID(),
    };
  }
  createProject(body: unknown, req: OperatorRequest) {
    return wire(
      "post /projects",
      this.repo.createProject(
        CreateProject.parse(body),
        req.operator.id,
        req.correlationId,
      ),
    );
  }
  projects(query: unknown) {
    const p = Pagination.parse(query);
    return wire("get /projects", this.repo.projects(p.page, p.limit));
  }
  project(id: string) {
    return wire("get /projects/{id}", this.repo.project(Id.parse(id)));
  }
  createTask(id: string, body: unknown, req: OperatorRequest) {
    return wire(
      "post /projects/{id}/tasks",
      this.repo.createTask(
        Id.parse(id),
        CreateTask.parse(body),
        req.operator.id,
        req.correlationId,
      ),
    );
  }
  tasks(id: string, query: unknown) {
    const p = Pagination.parse(query);
    return wire(
      "get /projects/{id}/tasks",
      this.repo.tasks(Id.parse(id), p.page, p.limit, p.status),
    );
  }
  task(id: string) {
    return wire("get /tasks/{id}", this.repo.detail(Id.parse(id)));
  }
  runs(id: string) {
    return wire("get /tasks/{id}/runs", this.repo.runs(Id.parse(id)));
  }
  events(id: string, query: unknown) {
    const p = Pagination.parse(query);
    return wire(
      "get /tasks/{id}/events",
      this.repo.events(Id.parse(id), p.page, p.limit),
    );
  }
  start(
    id: string,
    body: unknown,
    req: OperatorRequest,
    action: "PLAN" | "RETRY",
  ) {
    return wire(
      "post /tasks/{id}/plan",
      this.repo.start(
        this.command(req, id, action, EmptyCommand.parse(body)),
        action,
      ),
    );
  }
  cancel(id: string, body: unknown, req: OperatorRequest) {
    EmptyCommand.parse(body);
    return wire(
      "post /tasks/{id}/cancel",
      this.repo.cancel(Id.parse(id), req.operator.id, req.correlationId),
    );
  }
  decide(
    id: string,
    body: unknown,
    req: OperatorRequest,
    action: "APPROVE" | "CHANGES" | "REJECT",
  ) {
    const dto = (action === "CHANGES" ? ChangeDecision : Decision).parse(body);
    return wire(
      "post /approvals/{id}/approve",
      this.repo.decide(this.command(req, id, action, dto), action, dto),
    );
  }
  dashboard() {
    return wire("get /dashboard", this.repo.dashboard());
  }
  capabilities() {
    return {
      provider: this.repo.provider,
      label:
        this.repo.provider === "DEMO"
          ? "DEMO — no live AI"
          : "OPENAI — live Product Agent",
      planning: true,
      development: false,
      maxAttempts: 3,
      maxPlanVersions: 5,
      currency: "USD",
    };
  }
  openapi() {
    return openApi();
  }
  async ready() {
    await Promise.all([this.repo.db.$queryRaw`SELECT 1`, this.redis.ping()]);
    return { status: "ready" };
  }
}
