import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
if (existsSync(".env")) {
  console.log(".env exists; preserved.");
  process.exit(0);
}
const password = randomBytes(24).toString("hex");
const db = randomBytes(24).toString("hex");
const env = readFileSync(".env.example", "utf8")
  .replaceAll("LOCAL_PASSWORD", db)
  .replace("REPLACE_WITH_RANDOM_PASSWORD", password)
  .replace(
    "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
    randomBytes(32).toString("hex"),
  );
writeFileSync(".env", env, { mode: 0o600 });
mkdirSync(".local", { recursive: true });
writeFileSync(".local/operator-password", password + "\n", { mode: 0o600 });
console.log("Created .env and .local/operator-password (private files).");
