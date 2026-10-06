import { spawn } from "node:child_process";
const env = { ...process.env };
delete env.OPENAI_API_KEY;
const children = [
  ["dev:api", env],
  ["dev:worker", process.env],
  ["dev:web", env],
].map(([script, environment]) =>
  spawn("corepack", ["pnpm", script], { stdio: "inherit", env: environment }),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
