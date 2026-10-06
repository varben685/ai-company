import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    "api/main": "apps/api/src/main.ts",
    "worker/main": "apps/worker/src/main.ts",
  },
  format: ["cjs"],
  target: "node24",
  outDir: "dist",
  noExternal: [/^@company\//],
  clean: true,
  sourcemap: true,
});
