import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ChangeDecision,
  CreateProject,
  CreateTask,
  Decision,
  FinalDecision,
  StartDevelopment,
  RetryStage,
  EmptyCommand,
  Id,
  Pagination,
  openApi,
  outputContracts,
} from "@company/contracts";
import { PlatformRepository, M2Repository } from "@company/database";
import { dockerImageId, tarSnapshot } from "@company/workspace";
import { DomainError } from "@company/workflow";
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
  private get m2() {
    return new M2Repository(this.repo, undefined, {
      developer: process.env.OPENAI_DEVELOPER_MODEL ?? "gpt-4.1-mini",
      reviewer: process.env.OPENAI_REVIEWER_MODEL ?? "gpt-4.1-mini",
    });
  }
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
  sources() {
    return wire(
      "get /workspace-sources",
      this.m2.source().then((s) => [s]),
    );
  }
  development(id: string) {
    return wire("get /tasks/{id}/development", this.m2.view(Id.parse(id)));
  }
  async develop(id: string, body: unknown, req: OperatorRequest) {
    const dto = StartDevelopment.parse(body);
    try {
      await dockerImageId();
    } catch {
      throw new DomainError(
        "WORKSPACE_UNAVAILABLE",
        503,
        "The pinned Docker workspace image is unavailable. Install it before starting development.",
      );
    }
    return wire(
      "post /tasks/{id}/develop",
      this.m2.start(this.command(req, id, "START_DEVELOPMENT", dto), dto),
    );
  }
  retryStage(id: string, body: unknown, req: OperatorRequest) {
    const dto = RetryStage.parse(body);
    return wire(
      "post /tasks/{id}/retry-stage",
      this.m2.retry(this.command(req, id, "RETRY_STAGE", dto), dto),
    );
  }
  async artifact(id: string) {
    return wire("get /artifacts/{id}", this.m2.artifact(Id.parse(id)));
  }
  async artifactContent(id: string) {
    const content = await this.m2.content(Id.parse(id));
    if (Buffer.byteLength(content) > 512 * 1024)
      throw new DomainError(
        "ARTIFACT_CONTENT_TOO_LARGE",
        413,
        "Download the code package instead.",
      );
    return wire("get /artifacts/{id}/content", Promise.resolve({ content }));
  }
  async artifactDownload(id: string) {
    const a = await this.m2.artifact(Id.parse(id));
    if (!["CANDIDATE", "BASELINE"].includes(a.kind))
      throw new DomainError("ARTIFACT_NOT_DOWNLOADABLE", 409);
    const snapshot = await this.m2.store.read(a.storageKey, a.hash);
    return tarSnapshot(snapshot);
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
    if (
      action !== "CHANGES" &&
      body &&
      typeof body === "object" &&
      "candidateArtifactId" in body
    ) {
      const dto = FinalDecision.parse(body);
      return wire(
        "post /approvals/{id}/approve",
        this.m2.final(
          this.command(req, id, `FINAL_${action}`, dto),
          action,
          dto,
        ),
      );
    }
    const dto = (action === "CHANGES" ? ChangeDecision : Decision).parse(body);
    return wire(
      "post /approvals/{id}/approve",
      this.repo.decide(this.command(req, id, action, dto), action, dto),
    );
  }
  dashboard() {
    return wire("get /dashboard", this.repo.dashboard());
  }
  async capabilities() {
    let ready = false;
    try {
      await dockerImageId();
      ready = true;
    } catch {}
    return {
      provider: this.repo.provider,
      label:
        this.repo.provider === "DEMO"
          ? "DEMO — no live AI"
          : "OPENAI — live Product, Developer & Reviewer Agents",
      planning: true,
      development: ready,
      workspaceReady: ready,
      maxRounds: 3,
      workspaceSources: ["sample-todo-v1"],
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
