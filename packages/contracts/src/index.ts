import { z } from "zod";
export const Id = z.uuid();
export const Priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
export const TaskStatus = z.enum([
  "DRAFT",
  "QUEUED_FOR_PLANNING",
  "PLANNING",
  "WAITING_PLAN_APPROVAL",
  "PLAN_APPROVED",
  "QUEUED_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "QUEUED_FOR_VALIDATION",
  "VALIDATING",
  "QUEUED_FOR_REVIEW",
  "REVIEWING",
  "WAITING_FINAL_APPROVAL",
  "HUMAN_REVIEW_REQUIRED",
  "BLOCKED",
  "DONE",
  "REJECTED",
  "FAILED",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const priorityOrder = { URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 } as const;
const text = (max: number) => z.string().trim().min(1).max(max);
export const Context = z
  .object({
    product: z.string().max(10000),
    architecture: z.string().max(10000),
    codingStandards: z.string().max(10000),
    testing: z.string().max(10000),
    security: z.string().max(10000),
    decisions: z.string().max(10000),
  })
  .strict();
export const CreateProject = z
  .object({
    name: text(160),
    description: text(10000),
    context: Context,
    workspaceSourceId: z.literal("sample-todo-v1").nullable().optional(),
  })
  .strict();
export const CreateTask = z
  .object({
    title: text(200),
    description: text(16000),
    priority: Priority.default("NORMAL"),
  })
  .strict();
export const EmptyCommand = z.object({}).strict();
export const Decision = z
  .object({
    planId: Id,
    expectedTaskVersion: z.number().int().positive(),
    comment: z.string().trim().max(4000).optional(),
  })
  .strict();
export const ChangeDecision = Decision.extend({ comment: text(4000) });
export const StartDevelopment = z
  .object({
    approvedPlanId: Id,
    expectedTaskVersion: z.number().int().positive(),
    sourceId: z.literal("sample-todo-v1"),
  })
  .strict();
export const FinalDecision = z
  .object({
    candidateArtifactId: Id,
    candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    validationRunId: Id,
    reviewArtifactId: Id,
    expectedTaskVersion: z.number().int().positive(),
    comment: z.string().trim().max(4000).optional(),
  })
  .strict();
export const RetryStage = z
  .object({
    expectedTaskVersion: z.number().int().positive(),
    failureStage: z.enum(["PRODUCT", "DEVELOPER", "VALIDATION", "REVIEWER"]),
    targetId: Id,
  })
  .strict();
export const DeveloperResult = z
  .object({
    schemaVersion: z.literal("1"),
    outcome: z.enum(["IMPLEMENTED", "BLOCKED"]),
    summary: z.string(),
    claimedChangedFiles: z.array(z.string()),
    claimedChecks: z.array(
      z.object({ commandId: z.string(), summary: z.string() }).strict(),
    ),
    remainingRisks: z.array(z.string()),
    blockingReason: z.string().nullable(),
  })
  .strict();
export const BusinessDeveloperResult = DeveloperResult.superRefine((r, c) => {
  if (
    !r.summary.trim() ||
    JSON.stringify(r).length > 30000 ||
    r.claimedChangedFiles.length > 200 ||
    r.claimedChecks.length > 60 ||
    (r.outcome === "BLOCKED" && !r.blockingReason?.trim())
  )
    c.addIssue({ code: "custom", message: "Invalid developer result" });
});
export const ReviewReport = z
  .object({
    schemaVersion: z.literal("1"),
    verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]),
    summary: z.string(),
    issues: z.array(
      z
        .object({
          severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
          category: z.enum([
            "BUG",
            "SECURITY",
            "REQUIREMENT",
            "TEST",
            "MAINTAINABILITY",
          ]),
          file: z.string().nullable(),
          line: z.number().int().positive().nullable(),
          description: z.string(),
          suggestion: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const BusinessReviewReport = ReviewReport.superRefine((r, c) => {
  if (
    !r.summary.trim() ||
    JSON.stringify(r).length > 30000 ||
    r.issues.length > 60 ||
    r.issues.some((i) => !i.description.trim() || !i.suggestion.trim())
  )
    c.addIssue({ code: "custom", message: "Invalid review report" });
});
export const Login = z
  .object({ password: z.string().min(1).max(256) })
  .strict();
export const Pagination = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: TaskStatus.optional(),
  })
  .strict();
export const ProductPlanSchema = z
  .object({
    schemaVersion: z.literal("1"),
    summary: z.string(),
    requirements: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    implementationSteps: z.array(
      z.object({ order: z.number().int(), description: z.string() }).strict(),
    ),
    assumptions: z.array(z.string()),
    openQuestions: z.array(z.string()),
    risks: z.array(z.string()),
    complexity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  })
  .strict();
export type ProductPlan = z.infer<typeof ProductPlanSchema>;
export const BusinessPlanSchema = ProductPlanSchema.superRefine((p, c) => {
  const bad = (message: string) => c.addIssue({ code: "custom", message });
  if (!p.summary.trim() || p.summary.length > 4000) bad("Invalid summary");
  for (const key of [
    "requirements",
    "acceptanceCriteria",
    "assumptions",
    "openQuestions",
    "risks",
  ] as const) {
    if (p[key].length > 40 || p[key].some((x) => !x.trim() || x.length > 2000))
      bad(`Invalid ${key}`);
  }
  if (!p.requirements.length || !p.acceptanceCriteria.length)
    bad("Requirements and criteria are required");
  if (
    !p.implementationSteps.length ||
    p.implementationSteps.length > 40 ||
    p.implementationSteps.some(
      (s, i) =>
        s.order !== i + 1 ||
        !s.description.trim() ||
        s.description.length > 2000,
    )
  )
    bad("Steps must be nonempty and consecutive");
  if (JSON.stringify(p).length > 80000) bad("Plan too large");
});
export const ProductInput = z
  .object({
    projectId: Id,
    taskId: Id,
    runId: Id,
    task: CreateTask,
    project: CreateProject.extend({
      contextVersion: z.number().int().positive(),
    }),
    previousPlan: ProductPlanSchema.nullable(),
    changeRequest: z.string().max(4000).nullable(),
  })
  .strict();
export type ProductAgentInput = z.infer<typeof ProductInput>;
export const JobPayload = z
  .object({ projectId: Id, taskId: Id, agentRunId: Id })
  .strict();
export type JobPayload = z.infer<typeof JobPayload>;
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  correlationId: z.string(),
});
export const routes = [
  ["post", "/projects", CreateProject],
  ["get", "/projects", null],
  ["get", "/projects/{id}", null],
  ["get", "/workspace-sources", null],
  ["post", "/projects/{id}/tasks", CreateTask],
  ["get", "/projects/{id}/tasks", null],
  ["get", "/tasks/{id}", null],
  ["get", "/tasks/{id}/runs", null],
  ["get", "/tasks/{id}/events", null],
  ["get", "/tasks/{id}/development", null],
  ["post", "/tasks/{id}/plan", EmptyCommand],
  ["post", "/tasks/{id}/retry", EmptyCommand],
  ["post", "/tasks/{id}/develop", StartDevelopment],
  ["post", "/tasks/{id}/retry-stage", RetryStage],
  ["post", "/tasks/{id}/cancel", EmptyCommand],
  ["post", "/approvals/{id}/approve", Decision],
  ["post", "/approvals/{id}/request-changes", ChangeDecision],
  ["post", "/approvals/{id}/reject", Decision],
  ["get", "/artifacts/{id}", null],
  ["get", "/artifacts/{id}/content", null],
  ["get", "/artifacts/{id}/download", null],
  ["post", "/auth/login", Login],
  ["post", "/auth/logout", EmptyCommand],
  ["get", "/auth/session", null],
  ["get", "/dashboard", null],
  ["get", "/capabilities", null],
  ["get", "/health/live", null],
  ["get", "/health/ready", null],
] as const;
// Wire contracts: UTC date strings and decimal money strings, never browser ORM objects.
export const ProjectView = CreateProject.extend({
  id: Id,
  status: z.string(),
  contextVersion: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const PlanView = z.object({
  id: Id,
  versionNumber: z.number(),
  content: ProductPlanSchema,
  createdAt: z.string(),
});
export const ApprovalView = z.object({
  id: Id,
  type: z.enum(["PLAN", "FINAL_CODE"]),
  targetPlanId: Id.nullable(),
  targetArtifactId: Id.nullable(),
  targetSnapshot: z.unknown().nullable(),
  status: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  comment: z.string().nullable(),
});
export const TaskView = CreateTask.extend({
  priorityRank: z.number().int(),
  id: Id,
  projectId: Id,
  status: TaskStatus,
  version: z.number(),
  currentPlanId: Id.nullable(),
  approvedPlanId: Id.nullable(),
  activeRunId: Id.nullable(),
  failureCode: z.string().nullable(),
  failureStage: z.string().nullable(),
  developmentSessionId: Id.nullable(),
  activeValidationId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const TaskDetail = TaskView.extend({
  plans: z.array(PlanView),
  approvals: z.array(ApprovalView),
});
export const AttemptView = UsageSchema.extend({
  currency: z.literal("USD").default("USD"),
  id: Id,
  attemptNumber: z.number(),
  status: z.string(),
  model: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  estimatedCostUsd: z.string().nullable(),
  pricingVersion: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  errorCode: z.string().nullable(),
  unknownModelCalls: z.number().int().nonnegative(),
  modelCalls: z.array(
    z.object({
      id: Id,
      sequence: z.number().int(),
      status: z.string(),
      model: z.string().nullable(),
      responseId: z.string().nullable(),
      providerRequestId: z.string().nullable(),
      inputTokens: z.number().int().nullable(),
      outputTokens: z.number().int().nullable(),
      cachedInputTokens: z.number().int().nullable(),
      estimatedCostUsd: z.string().nullable(),
      pricingVersion: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
    }),
  ),
  toolExecutions: z.array(
    z.object({
      id: Id,
      name: z.string(),
      inputSummary: z.string(),
      outcome: z.string(),
      durationMs: z.number().int(),
      outputHash: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export const RunView = z.object({
  id: Id,
  agentType: z.enum(["PRODUCT", "DEVELOPER", "REVIEWER"]),
  sessionId: Id.nullable(),
  round: z.number().int().nullable(),
  status: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  promptVersion: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  attemptCount: z.number(),
  attempts: z.array(AttemptView),
});
export const EventView = z.object({
  id: Id,
  type: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  createdAt: z.string(),
  correlationId: z.string(),
  payload: z.unknown(),
});
export const DashboardView = z.object({
  projects: z.number(),
  activeTasks: z.number(),
  pendingApprovals: z.number(),
  runs: z.number(),
  knownEstimatedCostUsd: z.string(),
  currency: z.literal("USD"),
  unknownAttempts: z.number(),
});
export const CapabilitiesView = z.object({
  provider: z.enum(["DEMO", "OPENAI"]),
  label: z.string(),
  planning: z.boolean(),
  development: z.boolean(),
  workspaceReady: z.boolean(),
  maxRounds: z.number(),
  workspaceSources: z.array(z.string()),
  maxAttempts: z.number(),
  maxPlanVersions: z.number(),
  currency: z.literal("USD"),
});
export const SessionView = z.object({
  actorId: z.string(),
  csrfToken: z.string(),
});
export const pageOf = <T extends z.ZodType>(schema: T) =>
  z.object({
    items: z.array(schema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  });

export const CommandView = z.object({
  runId: Id.optional(),
  taskId: Id,
  status: TaskStatus,
  version: z.number().int(),
});
export const OkView = z.object({ ok: z.boolean() });
export const HealthView = z.object({ status: z.string() });
export const SourceView = z.object({
  sourceId: z.literal("sample-todo-v1"),
  sourceVersion: z.string(),
  baselineHash: z.string(),
  policyVersion: z.string(),
  validatorVersion: z.string(),
});
export const ArtifactView = z.object({
  id: Id,
  kind: z.string(),
  hash: z.string(),
  snapshotHash: z.string().nullable(),
  byteSize: z.number(),
  round: z.number(),
  createdAt: z.string(),
});
export const DevelopmentView = z
  .object({
    session: z.object({
      id: Id,
      status: z.string(),
      sourceId: z.string(),
      sourceVersion: z.string(),
      baselineHash: z.string(),
      policyVersion: z.string(),
      validatorVersion: z.string(),
      currentRound: z.number(),
      currentCandidateId: Id.nullable(),
      approvedPlanId: Id,
    }),
    artifacts: z.array(ArtifactView.extend({ contentUrl: z.string() })),
    validations: z.array(
      z.object({
        id: Id,
        round: z.number(),
        candidateArtifactId: Id,
        candidateHash: z.string(),
        status: z.string(),
        report: z.unknown().nullable(),
        createdAt: z.string(),
      }),
    ),
    reviews: z.array(
      z.object({
        id: Id,
        round: z.number().nullable(),
        status: z.string(),
        outputArtifactId: Id.nullable(),
        provider: z.string(),
      }),
    ),
  })
  .nullable();
export const outputContracts: Record<string, z.ZodType> = {
  "post /projects": ProjectView,
  "get /projects": pageOf(ProjectView),
  "get /projects/{id}": ProjectView,
  "get /workspace-sources": z.array(SourceView),
  "post /projects/{id}/tasks": TaskView,
  "get /projects/{id}/tasks": pageOf(TaskView),
  "get /tasks/{id}": TaskDetail,
  "get /tasks/{id}/runs": z.array(RunView),
  "get /tasks/{id}/events": pageOf(EventView),
  "get /tasks/{id}/development": DevelopmentView,
  "post /tasks/{id}/plan": CommandView,
  "post /tasks/{id}/retry": CommandView,
  "post /tasks/{id}/develop": CommandView,
  "post /tasks/{id}/retry-stage": CommandView,
  "post /tasks/{id}/cancel": TaskView,
  "post /approvals/{id}/approve": CommandView,
  "post /approvals/{id}/request-changes": CommandView,
  "post /approvals/{id}/reject": CommandView,
  "get /artifacts/{id}": ArtifactView,
  "get /artifacts/{id}/content": z.object({ content: z.string() }),
  "get /artifacts/{id}/download": z.any(),
  "post /auth/login": SessionView,
  "post /auth/logout": OkView,
  "get /auth/session": SessionView,
  "get /dashboard": DashboardView,
  "get /capabilities": CapabilitiesView,
  "get /health/live": HealthView,
  "get /health/ready": HealthView,
};
export function openApi() {
  const paths: Record<string, unknown> = {};
  for (const [method, path, schema] of routes) {
    const existing = (paths[path] ?? {}) as Record<string, unknown>;
    const command =
      /\/plan$|\/retry$|\/develop$|\/retry-stage$|\/approvals\//.test(path);
    const anonymous = path.startsWith("/health") || path === "/auth/login";
    const paginated =
      method === "get" &&
      (path === "/projects" ||
        path.endsWith("/tasks") ||
        path.endsWith("/events"));
    const status =
      method === "post" && (path === "/projects" || path.endsWith("/tasks"))
        ? "201"
        : method === "post" &&
            /\/plan$|\/retry$|\/develop$|\/retry-stage$|\/request-changes$/.test(
              path,
            )
          ? "202"
          : "200";
    const output = outputContracts[method + " " + path]!;
    const errors = Object.fromEntries(
      ["400", "401", "403", "404", "409", "413", "429", "503"].map((code) => [
        code,
        {
          description: "Error",
          content: { "application/json": { schema: z.toJSONSchema(ApiError) } },
        },
      ]),
    );
    paths[path] = {
      ...existing,
      [method]: {
        security: anonymous ? [] : [{ session: [] }],
        parameters: [
          ...(path.includes("{id}")
            ? [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ]
            : []),
          ...(method === "post"
            ? [
                {
                  name: "Origin",
                  in: "header",
                  required: true,
                  schema: { type: "string" },
                },
                ...(!anonymous
                  ? [
                      {
                        name: "X-CSRF-Token",
                        in: "header",
                        required: true,
                        schema: { type: "string" },
                      },
                    ]
                  : []),
              ]
            : []),
          ...(command
            ? [
                {
                  name: "Idempotency-Key",
                  in: "header",
                  required: true,
                  schema: { type: "string", minLength: 8, maxLength: 128 },
                },
              ]
            : []),
          ...(paginated
            ? [
                {
                  name: "page",
                  in: "query",
                  schema: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100000,
                    default: 1,
                  },
                },
                {
                  name: "limit",
                  in: "query",
                  schema: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    default: 25,
                  },
                },
              ]
            : []),
          ...(method === "get" && path.endsWith("/tasks")
            ? [
                {
                  name: "status",
                  in: "query",
                  schema: z.toJSONSchema(TaskStatus),
                },
              ]
            : []),
        ],
        ...(schema
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: z.toJSONSchema(schema, {
                      target: "draft-2020-12",
                      io: "input",
                    }),
                  },
                },
              },
            }
          : {}),
        responses: {
          [status]: {
            description: "Success",
            content: { "application/json": { schema: z.toJSONSchema(output) } },
          },
          ...errors,
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "AI Company M2", version: "0.2.0" },
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "operator_session" },
      },
    },
  };
}
