import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FinalDecision,
  RetryStage,
  StartDevelopment,
  BusinessReviewReport,
} from "@company/contracts";
import {
  DomainError,
  transition,
  requiredValidationPass,
} from "@company/workflow";
import { ArtifactStore, builtinSource } from "@company/workspace";
import {
  event,
  json,
  type Command,
  type PlatformRepository,
  type Tx,
} from "./index";

export const FinalTarget = z
  .object({
    candidateArtifactId: z.uuid(),
    candidateHash: z.string(),
    validationRunId: z.uuid(),
    reviewArtifactId: z.uuid(),
    approvedPlanId: z.uuid(),
    baselineHash: z.string(),
    policyVersion: z.string(),
    validatorVersion: z.string(),
    sessionId: z.uuid(),
    round: z.number().int(),
  })
  .strict();
type FinalTarget = z.infer<typeof FinalTarget>;

export class M2Repository {
  constructor(
    readonly repo: PlatformRepository,
    readonly store = new ArtifactStore(),
    readonly models: { developer: string; reviewer: string } = {
      developer: "gpt-4.1-mini",
      reviewer: "gpt-4.1-mini",
    },
  ) {}
  get db() {
    return this.repo.db;
  }
  async source() {
    return (await builtinSource()).info;
  }
  async newRun(
    tx: Tx,
    t: { id: string; projectId: string; priority: string },
    sessionId: string,
    round: number,
    agentType: "DEVELOPER" | "REVIEWER",
    input: unknown,
  ) {
    const id = randomUUID();
    await tx.agentRun.create({
      data: {
        id,
        taskId: t.id,
        projectId: t.projectId,
        agentType,
        sessionId,
        round,
        provider: this.repo.provider,
        model:
          this.repo.provider === "OPENAI"
            ? this.models[agentType === "DEVELOPER" ? "developer" : "reviewer"]
            : null,
        promptVersion:
          agentType === "DEVELOPER" ? "developer-v1" : "reviewer-v1",
        inputSnapshot: json(input),
        inputCandidateHash:
          typeof input === "object" &&
          input &&
          ("candidateHash" in input || "inputCandidateHash" in input)
            ? String(
                "candidateHash" in input
                  ? input.candidateHash
                  : (input.inputCandidateHash ?? ""),
              ) || null
            : null,
      },
    });
    await tx.outboxMessage.create({
      data: {
        taskId: t.id,
        projectId: t.projectId,
        agentRunId: id,
        kind:
          agentType === "DEVELOPER"
            ? "DEVELOPMENT_REQUESTED"
            : "REVIEW_REQUESTED",
        payload: json({ projectId: t.projectId, taskId: t.id, agentRunId: id }),
      },
    });
    return id;
  }
  async start(c: Command, body: z.infer<typeof StartDevelopment>) {
    const source = await builtinSource();
    if (body.sourceId !== source.info.sourceId)
      throw new DomainError("UNKNOWN_SOURCE", 400);
    const baselineStored = await this.store.publish(source.snapshot);
    return this.repo.command(c, async (tx) => {
      const t = await this.repo.task(tx, c.resourceId);
      if (
        t.status !== "PLAN_APPROVED" ||
        t.version !== body.expectedTaskVersion ||
        t.approvedPlanId !== body.approvedPlanId
      )
        throw new DomainError(
          "STALE_DEVELOPMENT_START",
          409,
          "The approved plan or task version changed. Refresh before starting development.",
        );
      const project = await tx.project.findUniqueOrThrow({
        where: { id: t.projectId },
      });
      if (project.workspaceSourceId !== body.sourceId)
        throw new DomainError(
          "SOURCE_MISMATCH",
          409,
          "Development blocked: this project has no sample-todo-v1 source. Create a matching sample project and approve its plan.",
        );
      const context = project.context as { architecture?: string };
      if (
        !/node|javascript|esm/i.test(context.architecture ?? "") ||
        !/todo|teendő/i.test(`${t.title} ${t.description}`) ||
        !/complet|kész|finish/i.test(`${t.title} ${t.description}`)
      )
        throw new DomainError(
          "SOURCE_CONTEXT_MISMATCH",
          409,
          "Development blocked: this approved task must describe the sample Todo completion feature and a JavaScript/Node runtime.",
        );
      const status = transition(t.status, "START_DEVELOPMENT");
      const sessionId = randomUUID();
      await tx.developmentSession.create({
        data: {
          id: sessionId,
          projectId: t.projectId,
          taskId: t.id,
          approvedPlanId: body.approvedPlanId,
          sourceId: source.info.sourceId,
          sourceVersion: source.info.sourceVersion,
          baselineHash: source.info.baselineHash,
          policyVersion: source.info.policyVersion,
          validatorVersion: source.info.validatorVersion,
        },
      });
      const baseline = await tx.agentArtifact.create({
        data: {
          projectId: t.projectId,
          taskId: t.id,
          sessionId,
          round: 0,
          kind: "BASELINE",
          hash: baselineStored.hash,
          snapshotHash: source.snapshot.hash,
          byteSize: baselineStored.byteSize,
          storageKey: baselineStored.storageKey,
        },
      });
      await tx.developmentSession.update({
        where: { id: sessionId },
        data: { baselineArtifactId: baseline.id },
      });
      const plan = await tx.taskPlan.findUniqueOrThrow({
        where: { id: body.approvedPlanId },
      });
      const input = {
        schemaVersion: "1",
        sessionId,
        round: 1,
        projectId: t.projectId,
        taskId: t.id,
        approvedPlanId: body.approvedPlanId,
        task: { title: t.title, description: t.description },
        approvedPlan: plan.content,
        source: source.info,
        inputArtifactId: baseline.id,
        inputCandidateHash: null,
        previousReview: null,
        previousValidation: null,
      };
      const runId = await this.newRun(tx, t, sessionId, 1, "DEVELOPER", input);
      await tx.task.update({
        where: { id: t.id },
        data: {
          status,
          version: { increment: 1 },
          developmentSessionId: sessionId,
          activeRunId: runId,
          failureStage: null,
          failureCode: null,
        },
      });
      await event(
        tx,
        t,
        "DEVELOPMENT_REQUESTED",
        c.correlationId,
        c.actorId,
        runId,
        {
          sessionId,
          approvedPlanId: body.approvedPlanId,
          sourceId: body.sourceId,
        },
      );
      return { taskId: t.id, runId, status, version: t.version + 1 };
    });
  }
  async view(taskId: string) {
    await this.repo.detail(taskId);
    const session = await this.db.developmentSession.findUnique({
      where: { taskId },
    });
    if (!session) return null;
    const [artifacts, validations, reviews] = await Promise.all([
      this.db.agentArtifact.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "asc" },
      }),
      this.db.validationRun.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "asc" },
      }),
      this.db.agentRun.findMany({
        where: { sessionId: session.id, agentType: "REVIEWER" },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      session: {
        id: session.id,
        status: session.status,
        sourceId: session.sourceId,
        sourceVersion: session.sourceVersion,
        baselineHash: session.baselineHash,
        policyVersion: session.policyVersion,
        validatorVersion: session.validatorVersion,
        currentRound: session.currentRound,
        currentCandidateId: session.currentCandidateId,
        approvedPlanId: session.approvedPlanId,
      },
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        hash: a.hash,
        snapshotHash: a.snapshotHash,
        byteSize: a.byteSize,
        round: a.round,
        createdAt: a.createdAt,
        contentUrl: `/api/artifacts/${a.id}/content`,
      })),
      validations: validations.map((v) => ({
        id: v.id,
        round: v.round,
        candidateArtifactId: v.candidateArtifactId,
        candidateHash: v.candidateHash,
        status: v.status,
        report: v.report,
        createdAt: v.createdAt,
      })),
      reviews: reviews.map((r) => ({
        id: r.id,
        round: r.round,
        status: r.status,
        outputArtifactId: r.outputArtifactId,
        provider: r.provider,
      })),
    };
  }
  async artifact(id: string) {
    const a = await this.db.agentArtifact.findUnique({ where: { id } });
    if (!a) throw new DomainError("ARTIFACT_NOT_FOUND", 404);
    return a;
  }
  async content(id: string) {
    const a = await this.artifact(id);
    if (a.kind === "BASELINE" || a.kind === "CANDIDATE") {
      const snapshot = await this.store.read(a.storageKey, a.hash);
      return JSON.stringify({
        sourceId: snapshot.sourceId,
        sourceVersion: snapshot.sourceVersion,
        hash: snapshot.hash,
        files: snapshot.files.map((f) => ({
          path: f.path,
          content: Buffer.from(f.content, "base64").toString("utf8"),
        })),
      });
    }
    return this.store.readText(a.storageKey, a.hash);
  }
  async final(
    c: Command,
    action: "APPROVE" | "REJECT",
    body: z.infer<typeof FinalDecision>,
  ) {
    return this.repo.command(c, async (tx) => {
      const initial = await tx.approval.findUnique({
        where: { id: c.resourceId },
      });
      if (!initial || initial.type !== "FINAL_CODE")
        throw new DomainError("APPROVAL_NOT_FOUND", 404);
      const t = await this.repo.task(tx, initial.taskId);
      const approval = await tx.approval.findUniqueOrThrow({
        where: { id: initial.id },
      });
      if (
        t.status !== "WAITING_FINAL_APPROVAL" ||
        t.version !== body.expectedTaskVersion ||
        approval.status !== "PENDING" ||
        approval.targetArtifactId !== body.candidateArtifactId ||
        t.projectId !== approval.projectId
      )
        throw new DomainError(
          "STALE_FINAL_APPROVAL",
          409,
          "The candidate or task changed. Refresh and review the latest validation and code before deciding.",
        );
      const target = FinalTarget.parse(approval.targetSnapshot);
      if (
        target.candidateArtifactId !== body.candidateArtifactId ||
        target.candidateHash !== body.candidateHash ||
        target.validationRunId !== body.validationRunId ||
        target.reviewArtifactId !== body.reviewArtifactId ||
        target.approvedPlanId !== t.approvedPlanId ||
        target.sessionId !== t.developmentSessionId
      )
        throw new DomainError("STALE_FINAL_APPROVAL", 409);
      const session = await tx.developmentSession.findUniqueOrThrow({
        where: { id: target.sessionId },
      });
      const candidate = await tx.agentArtifact.findUniqueOrThrow({
        where: { id: target.candidateArtifactId },
      });
      const validation = await tx.validationRun.findUniqueOrThrow({
        where: { id: target.validationRunId },
      });
      const review = await tx.agentArtifact.findUniqueOrThrow({
        where: { id: target.reviewArtifactId },
      });
      const reviewerRun = review.producerRunId
        ? await tx.agentRun.findUnique({ where: { id: review.producerRunId } })
        : null;
      if (
        session.currentCandidateId !== candidate.id ||
        candidate.kind !== "CANDIDATE" ||
        candidate.hash !== target.candidateHash ||
        candidate.round !== target.round ||
        candidate.sessionId !== session.id ||
        session.baselineHash !== target.baselineHash ||
        session.policyVersion !== target.policyVersion ||
        session.validatorVersion !== target.validatorVersion ||
        validation.candidateArtifactId !== candidate.id ||
        validation.candidateHash !== candidate.hash ||
        validation.round !== candidate.round ||
        validation.status !== "PASS" ||
        validation.sessionId !== session.id ||
        review.kind !== "REVIEW_REPORT" ||
        review.sessionId !== session.id ||
        review.round !== candidate.round ||
        reviewerRun?.outputArtifactId !== review.id ||
        reviewerRun.inputCandidateHash !== candidate.hash ||
        (reviewerRun.inputSnapshot as { validationRunId?: string })
          .validationRunId !== validation.id
      )
        throw new DomainError("STALE_FINAL_APPROVAL", 409);
      const report = BusinessReviewReport.parse(
        JSON.parse(await this.store.readText(review.storageKey, review.hash)),
      );
      if (
        report.verdict !== "APPROVE" ||
        report.issues.some((i) => ["HIGH", "CRITICAL"].includes(i.severity)) ||
        !requiredValidationPass(validation.report)
      )
        throw new DomainError("VALIDATION_NOT_PASSING", 409);
      await this.store.read(candidate.storageKey, candidate.hash);
      await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: action === "APPROVE" ? "APPROVED" : "REJECTED",
          decidedBy: c.actorId,
          decidedAt: new Date(),
          comment: body.comment ?? null,
        },
      });
      const status = transition(
        t.status,
        action === "APPROVE" ? "DONE" : "REJECT",
      );
      await tx.task.update({
        where: { id: t.id },
        data: { status, version: { increment: 1 } },
      });
      await tx.developmentSession.update({
        where: { id: session.id },
        data: { status: action === "APPROVE" ? "DONE" : "REJECTED" },
      });
      await event(
        tx,
        t,
        action === "APPROVE" ? "CODE_APPROVED" : "CODE_REJECTED",
        c.correlationId,
        c.actorId,
        null,
        {
          candidateArtifactId: candidate.id,
          candidateHash: candidate.hash,
          validationRunId: validation.id,
          reviewArtifactId: review.id,
        },
      );
      return { taskId: t.id, status, version: t.version + 1 };
    });
  }
  async retry(c: Command, body: z.infer<typeof RetryStage>) {
    if (body.failureStage === "PRODUCT") return this.repo.start(c, "RETRY");
    return this.repo.command(c, async (tx) => {
      const t = await this.repo.task(tx, c.resourceId);
      if (
        t.status !== "FAILED" ||
        t.version !== body.expectedTaskVersion ||
        t.failureStage !== body.failureStage ||
        !t.developmentSessionId
      )
        throw new DomainError("STALE_RETRY", 409);
      const session = await tx.developmentSession.findUniqueOrThrow({
        where: { id: t.developmentSessionId },
      });
      if (body.failureStage === "VALIDATION") {
        const previous = await tx.validationRun.findUnique({
          where: { id: body.targetId },
        });
        if (
          !previous ||
          previous.sessionId !== session.id ||
          previous.status !== "ERROR"
        )
          throw new DomainError("STALE_RETRY", 409);
        const id = randomUUID();
        await tx.validationRun.create({
          data: {
            id,
            projectId: t.projectId,
            taskId: t.id,
            sessionId: session.id,
            round: previous.round,
            candidateArtifactId: previous.candidateArtifactId,
            candidateHash: previous.candidateHash,
            validatorVersion: previous.validatorVersion,
          },
        });
        await tx.outboxMessage.create({
          data: {
            projectId: t.projectId,
            taskId: t.id,
            validationRunId: id,
            kind: "VALIDATION_REQUESTED",
            payload: json({
              projectId: t.projectId,
              taskId: t.id,
              validationRunId: id,
            }),
          },
        });
        const status = transition(t.status, "RETRY_VALIDATION");
        await tx.developmentSession.update({
          where: { id: session.id },
          data: { status: "ACTIVE" },
        });
        await tx.task.update({
          where: { id: t.id },
          data: {
            status,
            version: { increment: 1 },
            activeValidationId: id,
            failureStage: null,
            failureCode: null,
          },
        });
        await event(
          tx,
          t,
          "VALIDATION_RETRY_REQUESTED",
          c.correlationId,
          c.actorId,
          null,
          { validationRunId: id },
        );
        return { taskId: t.id, status, version: t.version + 1 };
      }
      const previous = await tx.agentRun.findUnique({
        where: { id: body.targetId },
      });
      if (
        !previous ||
        previous.sessionId !== session.id ||
        previous.agentType !== body.failureStage ||
        previous.status !== "FAILED"
      )
        throw new DomainError("STALE_RETRY", 409);
      const agentType = body.failureStage as "DEVELOPER" | "REVIEWER";
      const runId = await this.newRun(
        tx,
        t,
        session.id,
        previous.round!,
        agentType,
        previous.inputSnapshot,
      );
      const status = transition(
        t.status,
        agentType === "DEVELOPER" ? "RETRY_DEVELOPER" : "RETRY_REVIEWER",
      );
      await tx.developmentSession.update({
        where: { id: session.id },
        data: { status: "ACTIVE" },
      });
      await tx.task.update({
        where: { id: t.id },
        data: {
          status,
          version: { increment: 1 },
          activeRunId: runId,
          failureStage: null,
          failureCode: null,
        },
      });
      await event(
        tx,
        t,
        "STAGE_RETRY_REQUESTED",
        c.correlationId,
        c.actorId,
        runId,
        { stage: agentType },
      );
      return { taskId: t.id, runId, status, version: t.version + 1 };
    });
  }
}
