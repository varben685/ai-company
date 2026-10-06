import { config as dotenv } from "dotenv";
dotenv({ quiet: true });
import { createApi } from "./app";
import { safeLog, ConfigurationError } from "@company/observability";
async function main() {
  const runtime = await createApi();
  await runtime.app.listen(runtime.env.API_PORT, "127.0.0.1");
  safeLog("API_READY", { port: runtime.env.API_PORT });
  const stop = () => void runtime.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError)
    safeLog("API_CONFIGURATION_ERROR", { message: error.message });
  else safeLog("API_STARTUP_FAILED");
  process.exitCode = 1;
});
