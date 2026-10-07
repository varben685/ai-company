import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Usage } from "@company/contracts";
export const CommonEnv = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  PROVIDER: z.enum(["DEMO", "OPENAI"]).default("DEMO"),
  OPENAI_PRODUCT_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_DEVELOPER_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_REVIEWER_MODEL: z.string().default("gpt-4.1-mini"),
});
export const ApiEnv = CommonEnv.extend({
  OPERATOR_PASSWORD: z.string().min(24),
  SESSION_SECRET: z.string().min(32),
  WEB_ORIGIN: z.url().default("http://127.0.0.1:3000"),
  API_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
});
export const WorkerEnv = CommonEnv.extend({
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]{1,80}$/)
    .default("company-m1"),
  PLANNING_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
  ATTEMPT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300000)
    .default(120000),
  LEASE_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  OPENAI_API_KEY: z.string().optional(),
}).superRefine((e, c) => {
  if (
    e.PROVIDER === "OPENAI" &&
    (!e.OPENAI_API_KEY?.trim() || !e.OPENAI_PRODUCT_MODEL?.trim())
  )
    c.addIssue({
      code: "custom",
      path: ["OPENAI_API_KEY"],
      message: "OPENAI requires a worker API key",
    });
});
export class ConfigurationError extends Error {}
export function config<T>(schema: z.ZodType<T>, env = process.env): T {
  if (env.PROVIDER === "OPENAI" && !env.OPENAI_PRODUCT_MODEL?.trim())
    throw new ConfigurationError("Invalid configuration: OPENAI_PRODUCT_MODEL");
  const r = schema.safeParse(env);
  if (!r.success)
    throw new ConfigurationError(
      "Invalid configuration: " +
        r.error.issues.map((i) => i.path.join(".") || i.message).join(", "),
    );
  return r.data;
}
const decimal = z.string().regex(/^\d+(\.\d{1,8})?$/);
export const PricingSchema = z.object({
  model: z.string().min(1),
  version: z.string().min(1),
  input: decimal,
  cached: decimal,
  output: decimal,
});
export type Pricing = z.infer<typeof PricingSchema>;
export function pricingFromEnv(env = process.env): Pricing | null {
  const p = PricingSchema.safeParse({
    model: env.PRICING_MODEL,
    version: env.PRICING_VERSION,
    input: env.PRICE_INPUT_PER_MILLION,
    cached: env.PRICE_CACHED_PER_MILLION,
    output: env.PRICE_OUTPUT_PER_MILLION,
  });
  return p.success ? p.data : null;
}
export function pricingForModel(
  model: string | null,
  env = process.env,
): Pricing | null {
  if (!model) return null;
  const custom = pricingFromEnv(env);
  if (custom?.model === model) return custom;
  // Official model page checked 2026-10-06. Exact snapshot only; other models remain unknown.
  if (model === "gpt-4.1-mini-2025-04-14")
    return {
      model,
      version: "openai-model-page-2026-10-06",
      input: "0.40",
      cached: "0.10",
      output: "1.60",
    };
  return null;
}
export function estimate(
  provider: string,
  model: string | null,
  u: Usage,
  p: Pricing | null,
): string | null {
  if (provider === "DEMO") return "0.00000000";
  if (
    !p ||
    !PricingSchema.safeParse(p).success ||
    p.model !== model ||
    u.inputTokens === null ||
    u.outputTokens === null ||
    u.cachedInputTokens === null ||
    u.cachedInputTokens > u.inputTokens
  )
    return null;
  if (
    Object.values(u).some(
      (n) => n === null || !Number.isSafeInteger(n) || n < 0,
    )
  )
    return null;
  return new Prisma.Decimal(u.inputTokens - u.cachedInputTokens)
    .mul(p.input)
    .add(new Prisma.Decimal(u.cachedInputTokens).mul(p.cached))
    .add(new Prisma.Decimal(u.outputTokens).mul(p.output))
    .div(1000000)
    .toFixed(8);
}
export function safeLog(
  code: string,
  fields: Record<string, string | number> = {},
) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), code, ...fields }),
  );
}
