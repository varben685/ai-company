import type { ProductAgentInput, ProductPlan } from "@company/contracts";
import { randomUUID } from "node:crypto";
export const context = {
  product: "Notes belong to signed-in users.",
  architecture: "NestJS / Next.js / PostgreSQL",
  codingStandards: "Strict TypeScript; services use repositories.",
  testing: "Endpoint integration tests",
  security: "Owner-only access",
  decisions: "No repository access",
};
export const project = {
  name: "Sample Notes App",
  description: "Private notes",
  context,
};
export const task = {
  title: "Archive notes",
  description:
    "Archive and restore notes. Hide archived notes in the default list and show them in a separate list.",
  priority: "HIGH" as const,
};
export const input: ProductAgentInput = {
  projectId: randomUUID(),
  taskId: randomUUID(),
  runId: randomUUID(),
  task,
  project: { ...project, contextVersion: 1 },
  previousPlan: null,
  changeRequest: null,
};
export const plan: ProductPlan = {
  schemaVersion: "1",
  summary: "Archive and restore notes with owner-only access.",
  requirements: [
    "Archive and restore notes",
    "Hide archived notes from the default list",
    "Show an archived list",
  ],
  acceptanceCriteria: [
    "Only the note owner can archive or restore",
    "Repeated archive or restore is idempotent",
  ],
  implementationSteps: [
    {
      order: 1,
      description: "Add an archive marker and owner-scoped services.",
    },
    { order: 2, description: "Add API/UI integration tests." },
  ],
  assumptions: ["Existing routes and files are unknown."],
  openQuestions: ["Should archived notes be retained indefinitely?"],
  risks: ["Default list filtering can regress."],
  complexity: "MEDIUM",
};
export function responseBody(output: unknown = plan) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 6000,
    model: "gpt-4.1-mini-2025-04-14",
    output: [
      {
        id: "msg_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(output),
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    metadata: {},
  };
}
