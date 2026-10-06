import { describe, it, expect, vi } from "vitest";
import {
  BusinessPlanSchema,
  CreateTask,
  CreateProject,
  ProductPlanSchema,
  priorityOrder,
  openApi,
} from "@company/contracts";
import { transition, checkApproval, backoff } from "@company/workflow";
import {
  estimate,
  pricingFromEnv,
  config,
  WorkerEnv,
} from "@company/observability";
import {
  DemoProvider,
  OpenAIProductProvider,
  productDefinition,
  classifyError,
} from "@company/agents";
import { input, plan, project, responseBody } from "./fixtures";
const options = { signal: new AbortController().signal, runId: input.runId };
describe("deterministic contracts and workflow", () => {
  it("rejects extra input fields, excessive input and invalid plan semantics", () => {
    expect(() =>
      CreateTask.parse({ ...input.task, status: "PLAN_APPROVED" }),
    ).toThrow();
    expect(() =>
      CreateProject.parse({ ...project, name: "x".repeat(161) }),
    ).toThrow();
    for (const bad of [
      { ...plan, summary: " " },
      { ...plan, requirements: [] },
      { ...plan, acceptanceCriteria: [""] },
      { ...plan, implementationSteps: [{ order: 2, description: "wrong" }] },
      { ...plan, risks: ["x".repeat(2001)] },
    ])
      expect(BusinessPlanSchema.safeParse(bad).success).toBe(false);
    expect(BusinessPlanSchema.parse(plan)).toEqual(plan);
  });
  it("allows only specified transitions and terminal states never move", () => {
    expect(transition("DRAFT", "PLAN")).toBe("QUEUED_FOR_PLANNING");
    expect(transition("PLANNING", "COMPLETE")).toBe("WAITING_PLAN_APPROVAL");
    expect(transition("WAITING_PLAN_APPROVAL", "APPROVE")).toBe(
      "PLAN_APPROVED",
    );
    for (const s of ["PLAN_APPROVED", "CANCELLED", "REJECTED"])
      for (const a of [
        "PLAN",
        "RETRY",
        "CLAIM",
        "COMPLETE",
        "APPROVE",
        "CHANGES",
        "REJECT",
        "FAIL",
        "CANCEL",
      ] as const)
        expect(() => transition(s, a)).toThrow();
    expect(() => transition("PLANNING", "APPROVE")).toThrow();
  });
  it("binds approval to task version and plan", () => {
    expect(() =>
      checkApproval(
        { status: "WAITING_PLAN_APPROVAL", version: 2, currentPlanId: "a" },
        "b",
        2,
      ),
    ).toThrow();
    expect(() =>
      checkApproval(
        { status: "WAITING_PLAN_APPROVAL", version: 2, currentPlanId: "a" },
        "a",
        1,
      ),
    ).toThrow();
  });
  it("priority maps urgent first and exponential retry stays bounded", () => {
    expect(Object.values(priorityOrder)).toEqual([1, 2, 3, 4]);
    expect(backoff(1, 0)).toBe(1000);
    expect(backoff(2, 0)).toBe(2000);
    expect(backoff(20, 0)).toBe(30000);
  });
  it("generates strict input OpenAPI from the same Zod contracts", () => {
    const doc = openApi();
    const path = doc.paths["/projects"] as {
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { additionalProperties: boolean } };
          };
        };
      };
    };
    expect(
      path.post.requestBody.content["application/json"].schema
        .additionalProperties,
    ).toBe(false);
    expect(Object.keys(doc.paths)).toContain("/approvals/{id}/approve");
  });
});
it("OPENAI configuration fails explicitly on missing key/model without leaking values", () => {
  const env = {
    PROVIDER: "OPENAI",
    DATABASE_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
  };
  expect(() =>
    config(WorkerEnv, { ...env, OPENAI_API_KEY: "fake-test-secret" }),
  ).toThrow("OPENAI_PRODUCT_MODEL");
  expect(() =>
    config(WorkerEnv, { ...env, OPENAI_PRODUCT_MODEL: "gpt-4.1-mini" }),
  ).toThrow("OPENAI_API_KEY");
  expect(() =>
    config(WorkerEnv, {
      ...env,
      OPENAI_PRODUCT_MODEL: "gpt-4.1-mini",
      OPENAI_API_KEY: "fake-test-secret",
      PLANNING_CONCURRENCY: "2",
    }),
  ).toThrow("PLANNING_CONCURRENCY");
});
describe("accounting", () => {
  const price = {
    model: "m",
    version: "v1",
    input: "2",
    cached: "1",
    output: "4",
  };
  it("does not double count cached input", () =>
    expect(
      estimate(
        "OPENAI",
        "m",
        { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 },
        price,
      ),
    ).toBe("0.00022000"));
  it("unknown usage, tariff, cached count and model stay unknown", () => {
    expect(
      estimate(
        "OPENAI",
        "m",
        { inputTokens: null, outputTokens: 10, cachedInputTokens: 0 },
        price,
      ),
    ).toBeNull();
    expect(
      estimate(
        "OPENAI",
        "m",
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: null },
        price,
      ),
    ).toBeNull();
    expect(
      estimate(
        "OPENAI",
        "other",
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        price,
      ),
    ).toBeNull();
    expect(pricingFromEnv({ PRICE_INPUT_PER_MILLION: "NaN" })).toBeNull();
    expect(
      estimate(
        "DEMO",
        null,
        { inputTokens: null, outputTokens: null, cachedInputTokens: null },
        null,
      ),
    ).toBe("0.00000000");
  });
});
describe("provider adapters through actual SDK", () => {
  it("DEMO is deterministic, reflects changes and respects pre-abort", async () => {
    const p = new DemoProvider();
    expect(await p.execute(productDefinition, input, options)).toEqual(
      await p.execute(productDefinition, input, options),
    );
    const changed = await p.execute(
      productDefinition,
      {
        ...input,
        previousPlan: plan,
        changeRequest: "Search archived notes by title",
      },
      options,
    );
    expect(changed.output.requirements).toContain(
      "Search archived notes by title",
    );
    await expect(
      p.execute(productDefinition, input, {
        ...options,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });
  it("DEMO handles the maximum accepted description and change request sizes", async () => {
    const output = await new DemoProvider().execute(
      productDefinition,
      {
        ...input,
        task: { ...input.task, description: "request ".repeat(2000) },
        changeRequest: "change ".repeat(571),
      },
      options,
    );
    expect(BusinessPlanSchema.safeParse(output.output).success).toBe(true);
  });
  it("uses schema output, no tools/store, real model/usage and no hidden retries", async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.text.format.type).toBe("json_schema");
      expect(body.tools ?? []).toEqual([]);
      expect(body.store).toBe(false);
      return new Response(JSON.stringify(responseBody()), {
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-test",
        },
      });
    });
    const result = await new OpenAIProductProvider(
      "fake-test-key",
      "gpt-4.1-mini",
      transport,
    ).execute(productDefinition, input, options);
    expect(result.output).toEqual(plan);
    expect(result.model).toBe("gpt-4.1-mini-2025-04-14");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
    });
    expect(result.providerRequestId).toBe("request-test");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, "PROVIDER_AUTH", false],
    [429, "PROVIDER_RATE_LIMIT", true],
    [500, "PROVIDER_UNAVAILABLE", true],
    [400, "PROVIDER_CONFIG", false],
  ])(
    "classifies HTTP %s without SDK retries",
    async (status, code, retryable) => {
      const transport = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "SECRET_RAW_PROVIDER_ERROR",
                type: "api_error",
              },
            }),
            {
              status: Number(status),
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const p = new OpenAIProductProvider("fake-test-key", "m", transport);
      await expect(
        p.execute(productDefinition, input, options),
      ).rejects.toMatchObject({ code, retryable, message: code });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("invalid output retains known usage and fails closed", async () => {
    const transport: typeof fetch = async () =>
      new Response(JSON.stringify(responseBody({ ...plan, summary: "" })), {
        headers: { "content-type": "application/json" },
      });
    await expect(
      new OpenAIProductProvider("fake", "m", transport).execute(
        productDefinition,
        input,
        options,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
      retryable: false,
      metadata: { usage: { inputTokens: 100 } },
    });
  });
  it("refusal remains a nonretryable accounted failure", async () => {
    const r = responseBody();
    r.output[0]!.content = [
      { type: "refusal", refusal: "Cannot comply" },
    ] as unknown as (typeof r.output)[0]["content"];
    const transport: typeof fetch = async () =>
      new Response(JSON.stringify(r), {
        headers: { "content-type": "application/json" },
      });
    await expect(
      new OpenAIProductProvider("fake", "m", transport).execute(
        productDefinition,
        input,
        options,
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_REFUSAL",
      retryable: false,
      metadata: { usage: { inputTokens: 100 } },
    });
  });
  it("missing provider usage/model stays unknown instead of using SDK defaults", async () => {
    const body = { ...responseBody(), usage: null, model: undefined };
    const transport: typeof fetch = async () =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    const result = await new OpenAIProductProvider(
      "fake",
      "configured-model",
      transport,
    ).execute(productDefinition, input, options);
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
    expect(result.model).toBeNull();
  });
  it("forwards cancellation to the real SDK transport", async () => {
    const controller = new AbortController();
    const transport: typeof fetch = async (_url, init) => {
      expect(init?.signal).toBeDefined();
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    await expect(
      new OpenAIProductProvider("fake", "m", transport).execute(
        productDefinition,
        input,
        { ...options, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
  });
  it("validates the provider schema and does not silently fall back", () => {
    expect(
      ProductPlanSchema.safeParse({ ...plan, status: "APPROVED" }).success,
    ).toBe(false);
    expect(() => new OpenAIProductProvider("", "m")).toThrow("PROVIDER_CONFIG");
    expect(classifyError({ name: "APIConnectionError" }).retryable).toBe(true);
  });
});
