import { BusinessPlanSchema, JobPayload } from "@company/contracts";
import { WorkerRepository, type Claim } from "@company/database";
import {
  classifyError,
  productDefinition,
  ProviderError,
  type AgentProvider,
  type AgentExecution,
} from "@company/agents";
export async function processPlanning(
  data: unknown,
  repo: WorkerRepository,
  provider: AgentProvider | ((claim: Claim) => AgentProvider),
  timeoutMs = 120000,
) {
  const claim = await repo.claim(JobPayload.parse(data));
  if (!claim) return;
  const controller = new AbortController();
  let timedOut = false;
  let result: AgentExecution<unknown>;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Attempt timed out", "TimeoutError"));
  }, timeoutMs);
  const beat = setInterval(
    () => {
      void repo
        .heartbeat(claim)
        .then((owned) => {
          if (!owned) controller.abort();
        })
        .catch(() => controller.abort());
    },
    Math.max(100, Math.floor(repo.leaseMs / 3)),
  );
  try {
    const selected =
      typeof provider === "function" ? provider(claim) : provider;
    const execution = selected.execute(productDefinition, claim.input, {
      signal: controller.signal,
      runId: claim.payload.agentRunId,
    });
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            new ProviderError(
              timedOut ? "PROVIDER_TIMEOUT" : "CANCELLED",
              timedOut,
              {
                provider: claim.provider as "DEMO" | "OPENAI",
                model: null,
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  cachedInputTokens: null,
                },
                providerRequestId: null,
              },
            ),
          ),
        { once: true },
      ),
    );
    execution.then(
      (late) => {
        if (controller.signal.aborted)
          void repo.repository
            .transaction((tx) => repo.accounting(tx, claim, late))
            .catch(() => undefined);
      },
      (error) => {
        if (
          controller.signal.aborted &&
          error instanceof ProviderError &&
          error.metadata.usage.inputTokens !== null
        )
          void repo.repository
            .transaction((tx) => repo.accounting(tx, claim, error.metadata))
            .catch(() => undefined);
      },
    );
    result = await Promise.race([execution, aborted]);
    if (!BusinessPlanSchema.safeParse(result.output).success)
      throw new ProviderError("INVALID_STRUCTURED_OUTPUT", false, result);
  } catch (error) {
    await repo.failure(claim, classifyError(error));
    return;
  } finally {
    clearTimeout(timeout);
    clearInterval(beat);
  }
  // DB errors leave the lease for crash recovery, never turn into fabricated provider failures.
  await repo.complete(claim, result);
}
