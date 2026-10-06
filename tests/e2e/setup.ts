import { execFileSync } from "node:child_process";
export default function setup() {
  if (!/^m1_e2e_[a-f0-9]{32}$/.test(process.env.M1_E2E_SCHEMA ?? ""))
    throw new Error("Invalid test schema");
  execFileSync("corepack", ["pnpm", "db:migrate"], {
    env: process.env,
    stdio: "pipe",
  });
}
