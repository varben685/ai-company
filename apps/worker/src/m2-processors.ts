import { createHash, randomUUID } from "node:crypto";
import {
  BusinessDeveloperResult,
  BusinessReviewReport,
  type JobPayload,
} from "@company/contracts";
import {
  ProviderError,
  OpenAIAgentProvider,
  developerDefinition,
  reviewerDefinition,
  classifyError,
  type AgentExecution,
  type DeveloperAgentWorkspace,
  type ReadOnlyAgentWorkspace,
} from "@company/agents";
import {
  type M2WorkerRepository,
  type StageClaim,
  type ValidationPayload,
} from "@company/database";
import {
  ArtifactStore,
  DockerWorkspaceBackend,
  RelativeFile,
  demoTodoImplementation,
  diffSnapshots,
  dockerImageId,
  validateCandidate,
} from "@company/workspace";

const digest = (x: string) => createHash("sha256").update(x).digest("hex");
function demoExecution<T>(output: T): AgentExecution<T> {
  return {
    output,
    provider: "DEMO",
    model: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    providerRequestId: null,
  };
}
async function own(repo: M2WorkerRepository, c: StageClaim) {
  const [r, t] = await Promise.all([
    repo.db.agentRun.findUnique({ where: { id: c.payload.agentRunId } }),
    repo.db.task.findUnique({ where: { id: c.payload.taskId } }),
  ]);
  return (
    !!r &&
    !!t &&
    r.status === "RUNNING" &&
    r.ownerToken === c.token &&
    !!r.leaseUntil &&
    r.leaseUntil > new Date() &&
    t.activeRunId === r.id &&
    t.developmentSessionId === c.sessionId &&
    t.status === (c.agentType === "DEVELOPER" ? "IMPLEMENTING" : "REVIEWING")
  );
}
async function recordTool(
  repo: M2WorkerRepository,
  c: StageClaim,
  name: string,
  inputSummary: string,
  outcome: string,
  content: string,
  durationMs: number,
) {
  await repo.db.toolExecution.create({
    data: {
      projectId: c.payload.projectId,
      agentRunId: c.payload.agentRunId,
      attemptId: c.attemptId,
      callId: `${name}-${randomUUID()}`,
      name,
      inputSummary: inputSummary.slice(0, 200),
      outcome,
      durationMs,
      outputHash: digest(content),
    },
  });
}
type LiveConfig = { key: string; model: string; timeoutMs?: number };
function abortPromise(signal: AbortSignal, timeout: () => boolean) {
  return new Promise<never>((_, reject) =>
    signal.addEventListener(
      "abort",
      () =>
        reject(
          new ProviderError(
            timeout() ? "PROVIDER_TIMEOUT" : "CANCELLED",
            timeout(),
          ),
        ),
      { once: true },
    ),
  );
}
export async function processDevelopment(
  payload: JobPayload,
  repo: M2WorkerRepository,
  backend = new DockerWorkspaceBackend(),
  store = new ArtifactStore(),
  live?: LiveConfig,
) {
  const c = await repo.claimAgent(payload, "DEVELOPER");
  if (!c) return;
  let handle: Awaited<
    ReturnType<DockerWorkspaceBackend["prepareAttempt"]>
  > | null = null;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, live?.timeoutMs ?? 600000);
  const beat = setInterval(
    () => {
      void repo
        .heartbeatAgent(c)
        .then((ok) => {
          if (!ok) {
            controller.abort();
            if (handle) void backend.terminate(handle);
          }
        })
        .catch(() => controller.abort());
    },
    Math.max(100, Math.floor(repo.leaseMs / 3)),
  );
  try {
    const session = await repo.db.developmentSession.findUniqueOrThrow({
      where: { id: c.sessionId },
    });
    const base = await repo.db.agentArtifact.findUniqueOrThrow({
      where: { id: session.baselineArtifactId! },
    });
    const input = c.input as { inputArtifactId?: string };
    const inputArtifact = await repo.db.agentArtifact.findUniqueOrThrow({
      where: { id: input.inputArtifactId },
    });
    if (
      inputArtifact.sessionId !== c.sessionId ||
      !["BASELINE", "CANDIDATE"].includes(inputArtifact.kind)
    )
      throw new ProviderError("INVALID_WORKSPACE_INPUT", false);
    const [baseline, snapshot] = await Promise.all([
      store.read(base.storageKey, base.hash),
      store.read(inputArtifact.storageKey, inputArtifact.hash),
    ]);
    handle = await backend.prepareAttempt({
      attemptId: c.attemptId,
      token: c.token,
      snapshot,
      owned: () => own(repo, c),
    });
    await repo.workspaceActive(c);
    let result: AgentExecution<unknown>;
    if (c.provider === "DEMO") {
      const prior = snapshot.files.find((f) => f.path === "src/todo.js");
      const current = prior ? Buffer.from(prior.content, "base64") : null;
      const started = Date.now();
      const write = await backend.tool(handle, {
        op: "write",
        path: "src/todo.js",
        content: demoTodoImplementation,
        expectedHash: current ? digest(current.toString("utf8")) : null,
      });
      await recordTool(
        repo,
        c,
        "write_file",
        "src/todo.js",
        "OK",
        JSON.stringify(write),
        Date.now() - started,
      );
      const checks = await backend.runCommand(handle, "unit-tests");
      await recordTool(
        repo,
        c,
        "run_command",
        "unit-tests",
        checks.exitCode === 0 ? "OK" : "FAIL",
        checks.output,
        checks.durationMs,
      );
      result = demoExecution(
        BusinessDeveloperResult.parse({
          schemaVersion: "1",
          outcome: "IMPLEMENTED",
          summary: `DEMO fixture implementation, round ${c.round}`,
          claimedChangedFiles: ["src/todo.js"],
          claimedChecks: [
            {
              commandId: "unit-tests",
              summary: checks.exitCode === 0 ? "Passed" : "Failed",
            },
          ],
          remainingRisks: [],
          blockingReason: null,
        }),
      );
    } else if (c.provider === "OPENAI" && live?.key) {
      const h = handle;
      const workspace: DeveloperAgentWorkspace = {
        listFiles: async (p, limit) => {
          if (
            p &&
            !["src", "test"].includes(p) &&
            !RelativeFile.safeParse(p).success
          )
            throw Error("DISALLOWED_PATH");
          const files = (await backend.tool(h, {
            op: "list",
            limit: Math.min(limit, 200),
          })) as string[];
          return p
            ? files.filter((f) => f === p || f.startsWith(p + "/"))
            : files;
        },
        readFile: (p, startLine, endLine) =>
          backend.tool(h, { op: "read", path: p, startLine, endLine }),
        search: (query, paths, limit) =>
          backend.search(h, { query, paths, limit }),
        writeFile: (p, content, expectedHash) =>
          backend.tool(h, { op: "write", path: p, content, expectedHash }),
        applyPatch: (patch) => backend.applyPatch(h, patch),
        runCommand: (commandId) => backend.runCommand(h, commandId),
        getDiff: () => backend.previewDiff(h, baseline),
      };
      const provider = new OpenAIAgentProvider(live.key, c.model ?? live.model);
      result = await Promise.race([
        provider.execute(developerDefinition, c.input, {
          signal: controller.signal,
          runId: c.payload.agentRunId,
          workspace,
          onModelCallStart: (n) => repo.modelCallStart(c, n),
          onModelCallFinish: (e) => repo.modelCallFinish(c, e),
          onTool: (e) => repo.toolEvent(c, e),
        }),
        abortPromise(controller.signal, () => timedOut),
      ]);
    } else throw new ProviderError("PROVIDER_CONFIG", false);
    if (BusinessDeveloperResult.parse(result.output).outcome === "BLOCKED") {
      await backend.terminate(handle);
      await repo.workspaceStopped(c);
      await repo.completeBlocked(c, result);
      return;
    }
    const draft = await backend.freezeCandidate(handle, baseline);
    await repo.workspaceStopped(c);
    const [candidate, diff] = await Promise.all([
      store.publish(draft.snapshot),
      store.publishText(draft.diff),
    ]);
    await repo.completeDevelopment(c, result, draft, candidate, diff);
  } catch (error) {
    const e = error instanceof ProviderError ? error : classifyError(error);
    await repo.failAgent(c, e).catch(() => undefined);
  } finally {
    clearInterval(beat);
    clearTimeout(timeout);
    if (handle) await backend.cleanup(handle).catch(() => undefined);
    await repo.workspaceCleaned(c).catch(() => undefined);
  }
}
export async function processValidation(
  payload: ValidationPayload,
  repo: M2WorkerRepository,
  store = new ArtifactStore(),
) {
  const c = await repo.claimValidation(payload);
  if (!c) return;
  const beat = setInterval(
    () => {
      void repo.heartbeatValidation(c).catch(() => undefined);
    },
    Math.max(100, Math.floor(repo.leaseMs / 3)),
  );
  try {
    const artifact = await repo.db.agentArtifact.findUniqueOrThrow({
      where: { id: c.candidateArtifactId },
    });
    if (
      artifact.hash !== c.candidateHash ||
      artifact.sessionId !== c.sessionId ||
      artifact.kind !== "CANDIDATE"
    )
      throw Error("STALE_CANDIDATE");
    const snapshot = await store.read(artifact.storageKey, artifact.hash);
    const result = await validateCandidate(snapshot, await dockerImageId());
    if (result.status === "ERROR")
      await repo.validationError(c, "VALIDATOR_ERROR");
    else
      await repo.completeValidation(c, {
        status: result.status,
        checks: result.checks.map((x) => ({
          ...x,
          output: x.output.slice(-8192),
        })),
      });
  } catch {
    await repo.validationError(c, "VALIDATOR_ERROR").catch(() => undefined);
  } finally {
    clearInterval(beat);
  }
}
export async function processReview(
  payload: JobPayload,
  repo: M2WorkerRepository,
  store = new ArtifactStore(),
  live?: LiveConfig,
) {
  const c = await repo.claimAgent(payload, "REVIEWER");
  if (!c) return;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, live?.timeoutMs ?? 600000);
  const beat = setInterval(
    () => {
      void repo
        .heartbeatAgent(c)
        .then((ok) => {
          if (!ok) controller.abort();
        })
        .catch(() => controller.abort());
    },
    Math.max(100, Math.floor(repo.leaseMs / 3)),
  );
  try {
    const input = c.input as {
      candidateArtifactId?: string;
      candidateHash?: string;
      validationRunId?: string;
      task?: { title?: string; description?: string };
    };
    const candidate = await repo.db.agentArtifact.findUniqueOrThrow({
      where: { id: input.candidateArtifactId },
    });
    if (
      candidate.hash !== input.candidateHash ||
      candidate.sessionId !== c.sessionId ||
      candidate.kind !== "CANDIDATE"
    )
      throw Error("STALE_REVIEW_INPUT");
    const frozen = await store.read(candidate.storageKey, candidate.hash); // Reviewer sees frozen bytes only.
    let result: AgentExecution<unknown>;
    if (c.provider === "DEMO") {
      const title = input.task?.title ?? "";
      const verdict = /demo-block/i.test(title)
        ? "BLOCK"
        : /demo-always-changes/i.test(title) ||
            (/demo-fix-once/i.test(title) && c.round === 1)
          ? "REQUEST_CHANGES"
          : "APPROVE";
      result = demoExecution(
        BusinessReviewReport.parse({
          schemaVersion: "1",
          verdict,
          summary: `DEMO readonly review of candidate ${candidate.hash.slice(0, 12)}`,
          issues:
            verdict === "REQUEST_CHANGES"
              ? [
                  {
                    severity: "MEDIUM",
                    category: "MAINTAINABILITY",
                    file: "src/todo.js",
                    line: null,
                    description: "Controlled DEMO fix-round scenario",
                    suggestion: "Review again after a fresh attempt.",
                  },
                ]
              : [],
        }),
      );
    } else if (c.provider === "OPENAI" && live?.key) {
      const session = await repo.db.developmentSession.findUniqueOrThrow({
        where: { id: c.sessionId },
      });
      const base = await repo.db.agentArtifact.findUniqueOrThrow({
        where: { id: session.baselineArtifactId! },
      });
      const baseline = await store.read(base.storageKey, base.hash);
      const readOnly: ReadOnlyAgentWorkspace = {
        listFiles: async (p, limit) => {
          if (
            p &&
            !["src", "test"].includes(p) &&
            !RelativeFile.safeParse(p).success
          )
            throw Error("DISALLOWED_PATH");
          return frozen.files
            .map((f) => f.path)
            .filter((f) => !p || f === p || f.startsWith(p + "/"))
            .slice(0, Math.min(limit, 200));
        },
        readFile: async (p, startLine, endLine) => {
          RelativeFile.parse(p);
          if (startLine < 1 || endLine < startLine || endLine - startLine > 400)
            throw Error("INVALID_SLICE");
          const f = frozen.files.find((f) => f.path === p);
          if (!f) throw Error("FILE_NOT_FOUND");
          const lines = Buffer.from(f.content, "base64")
            .toString("utf8")
            .split("\n");
          return {
            content: lines
              .slice(startLine - 1, endLine)
              .join("\n")
              .slice(0, 30000),
            totalLines: lines.length,
          };
        },
        search: async (query, paths, limit) => {
          if (
            !query ||
            query.length > 200 ||
            paths.length > 30 ||
            limit < 1 ||
            limit > 100
          )
            throw Error("INVALID_SEARCH");
          const selected = paths.length
            ? paths.map((p) => RelativeFile.parse(p))
            : frozen.files.map((f) => f.path);
          const result: { path: string; line: number; text: string }[] = [];
          for (const p of selected) {
            const f = frozen.files.find((f) => f.path === p);
            if (!f) continue;
            for (const [i, line] of Buffer.from(f.content, "base64")
              .toString("utf8")
              .split("\n")
              .entries())
              if (line.includes(query)) {
                result.push({ path: p, line: i + 1, text: line.slice(0, 300) });
                if (result.length >= limit) return result;
              }
          }
          return result;
        },
        getDiff: async () => {
          const d = diffSnapshots(baseline, frozen);
          return {
            changedFiles: d.changedFiles,
            diff: d.diff.slice(0, 30000),
            truncated: d.diff.length > 30000,
          };
        },
      };
      const provider = new OpenAIAgentProvider(live.key, c.model ?? live.model);
      result = await Promise.race([
        provider.execute(reviewerDefinition, c.input, {
          signal: controller.signal,
          runId: c.payload.agentRunId,
          workspace: readOnly,
          onModelCallStart: (n) => repo.modelCallStart(c, n),
          onModelCallFinish: (e) => repo.modelCallFinish(c, e),
          onTool: (e) => repo.toolEvent(c, e),
        }),
        abortPromise(controller.signal, () => timedOut),
      ]);
    } else throw new ProviderError("PROVIDER_CONFIG", false);
    const review = await store.publishText(JSON.stringify(result.output));
    await repo.completeReview(c, result, review);
  } catch (error) {
    const e = error instanceof ProviderError ? error : classifyError(error);
    await repo.failAgent(c, e).catch(() => undefined);
  } finally {
    clearInterval(beat);
    clearTimeout(timeout);
  }
}
