import "dotenv/config";
import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
const schema =
  process.env.M1_E2E_SCHEMA ?? "m1_e2e_" + randomUUID().replaceAll("-", "");
process.env.M1_E2E_SCHEMA = schema;
const database = new URL(process.env.DATABASE_URL!);
database.searchParams.set("schema", schema);
process.env.DATABASE_URL = database.toString();
process.env.QUEUE_PREFIX = schema;
process.env.M1_E2E_SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.SESSION_SECRET = process.env.M1_E2E_SESSION_SECRET;
const built = process.env.M1_E2E_BUILT === "1";
export default defineConfig({
  globalSetup: "./tests/e2e/setup.ts",
  globalTeardown: "./tests/e2e/teardown.ts",
  testDir: "tests/e2e",
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: built ? "corepack pnpm start:api" : "corepack pnpm dev:api",
      url: "http://127.0.0.1:3001/health/ready",
      reuseExistingServer: false,
      timeout: 60000,
      env: { PROVIDER: "DEMO", OPENAI_API_KEY: "" },
    },
    {
      command: built ? "corepack pnpm start:web" : "corepack pnpm dev:web",
      url: "http://127.0.0.1:3000/login",
      reuseExistingServer: false,
      timeout: 120000,
      env: { OPENAI_API_KEY: "" },
    },
  ],
});
