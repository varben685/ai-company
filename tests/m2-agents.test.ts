import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  OpenAIAgentProvider,
  developerDefinition,
  reviewerDefinition,
} from "@company/agents";
import { responseBody } from "./fixtures";

const uuid = () => randomUUID();
const source = {
  sourceId: "sample-todo-v1",
  sourceVersion: "1",
  baselineHash: "a".repeat(64),
  policyVersion: "sample-policy-v1",
  validatorVersion: "sample-validator-v1",
};
const base = {
  schemaVersion: "1",
  sessionId: uuid(),
  round: 1,
  projectId: uuid(),
  taskId: uuid(),
  approvedPlanId: uuid(),
  task: { title: "Complete todos", description: "Add completion" },
  approvedPlan: { requirements: ["Add completion"] },
};
const reviewInput = {
  ...base,
  baselineHash: source.baselineHash,
  candidateArtifactId: uuid(),
  candidateHash: "b".repeat(64),
  validationRunId: uuid(),
  validationReport: { status: "PASS", checks: [{ exitCode: 0 }] },
};
const developerInput = {
  ...base,
  source,
  inputArtifactId: uuid(),
  inputCandidateHash: null,
  previousReview: null,
  previousValidation: null,
};
const headers = {
  "content-type": "application/json",
  "x-request-id": "fake-request",
};
describe("M2 installed Agents SDK integration", () => {
  it("exposes write and named command tools only to Developer", async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const names = body.tools.map((x: { name: string }) => x.name);
      expect(names).toContain("write_file");
      expect(names).toContain("apply_patch");
      expect(names).toContain("run_command");
      expect(body.store).toBe(false);
      return new Response(
        JSON.stringify(
          responseBody({
            schemaVersion: "1",
            outcome: "BLOCKED",
            summary: "Need more input",
            claimedChangedFiles: [],
            claimedChecks: [],
            remainingRisks: [],
            blockingReason: "Input unavailable",
          }),
        ),
        { headers },
      );
    });
    const workspace = {
      listFiles: async () => [],
      readFile: async () => ({ content: "", totalLines: 0 }),
      search: async () => [],
      getDiff: async () => ({ changedFiles: [], diff: "", truncated: false }),
      writeFile: async () => ({ hash: "a" }),
      applyPatch: async () => ({ hash: "a" }),
      runCommand: async () => ({ exitCode: 0 }),
    };
    const result = await new OpenAIAgentProvider(
      "fake",
      "gpt-4.1-mini",
      transport,
    ).execute(developerDefinition, developerInput, {
      signal: new AbortController().signal,
      runId: uuid(),
      workspace,
    });
    expect(result.output.outcome).toBe("BLOCKED");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("allows Reviewer only readonly tools and records every SDK response and tool call", async () => {
    const calls: number[] = [];
    const finished: {
      sequence: number;
      status: string;
      inputTokens: number | null;
    }[] = [];
    const tools: string[] = [];
    let count = 0;
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const names = body.tools.map((x: { name: string }) => x.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_files",
          "read_file",
          "search",
          "get_diff",
        ]),
      );
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("apply_patch");
      expect(names).not.toContain("run_command");
      count++;
      const response = responseBody(
        count === 1
          ? {}
          : {
              schemaVersion: "1",
              verdict: "APPROVE",
              summary: "Candidate passes",
              issues: [],
            },
      );
      if (count === 1) {
        response.output = [
          {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            call_id: "call_1",
            name: "get_diff",
            arguments: "{}",
          } as never,
        ];
      }
      response.usage.input_tokens = count * 100;
      return new Response(JSON.stringify(response), { headers });
    });
    const workspace = {
      listFiles: async () => [],
      readFile: async () => ({ content: "", totalLines: 0 }),
      search: async () => [],
      getDiff: async () => ({
        changedFiles: ["src/todo.js"],
        diff: "+export function setCompleted() {}",
        truncated: false,
      }),
    };
    const result = await new OpenAIAgentProvider(
      "fake",
      "gpt-4.1-mini",
      transport,
    ).execute(reviewerDefinition, reviewInput, {
      signal: new AbortController().signal,
      runId: uuid(),
      workspace,
      onModelCallStart: async (n) => {
        calls.push(n);
      },
      onModelCallFinish: async (e) => {
        finished.push({
          sequence: e.sequence,
          status: e.status,
          inputTokens: e.usage.inputTokens,
        });
      },
      onTool: async (e) => {
        tools.push(e.name);
      },
    });
    expect(result.output.verdict).toBe("APPROVE");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([1, 2]);
    expect(finished).toEqual([
      { sequence: 1, status: "SUCCEEDED", inputTokens: 100 },
      { sequence: 2, status: "SUCCEEDED", inputTokens: 200 },
    ]);
    expect(tools).toEqual(["get_diff"]);
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(100);
  });
});
