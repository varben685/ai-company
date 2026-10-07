import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

let worker: ChildProcess;
test.beforeAll(() => {
  worker = spawn(
    "corepack",
    ["pnpm", process.env.M1_E2E_BUILT === "1" ? "start:worker" : "dev:worker"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PROVIDER: "DEMO", OPENAI_API_KEY: "" },
      stdio: "ignore",
      detached: true,
    },
  );
});
test.afterAll(() => {
  if (worker.pid) process.kill(-worker.pid, "SIGTERM");
});

test("DEMO: approved plan → real code → validation → review → exact final approval", async ({
  page,
}) => {
  await page.goto("/login");
  await page
    .getByLabel("Operator password")
    .fill(
      process.env.OPERATOR_PASSWORD ??
        readFileSync(".local/operator-password", "utf8").trim(),
    );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.getByRole("link", { name: "Open projects" }).click();
  const name = "M2 sample " + Date.now();
  await page.getByLabel("Workspace source").selectOption("sample-todo-v1");
  await page.getByLabel("Project name").fill(name);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Versioned sample todo store using Node JavaScript ESM.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page
    .getByRole("link")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .click();
  await page.getByLabel("Task title").fill("demo-fix-once: Complete todos");
  await page
    .getByLabel("What should change?")
    .fill(
      "Implement setCompleted(id, completed), reject unknown IDs, and let listTodos hide completed todos when includeCompleted is false. Preserve create and list behavior.",
    );
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page).toHaveURL(/tasks\//);
  await page.getByRole("button", { name: "Start planning" }).click();
  await expect(
    page.getByRole("button", { name: "Approve plan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(
    page.getByRole("button", { name: "Start development" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start development" }).click();
  await expect(
    page.getByRole("heading", { name: "Human final code decision" }),
  ).toBeVisible({ timeout: 45000 });
  await expect(
    page.getByText("Independent validation · round 1"),
  ).toBeVisible();
  await expect(page.getByText("DEMO Reviewer · round 1")).toBeVisible();
  await expect(
    page.getByText("Independent validation · round 2"),
  ).toBeVisible();
  await expect(page.getByText("DEMO Reviewer · round 2")).toBeVisible();
  await page.getByText("Cumulative diff · round 2").click();
  await expect(
    page
      .locator("pre.preserve")
      .filter({ hasText: "+export function setCompleted" })
      .last(),
  ).toBeVisible();
  const download = page
    .getByRole("link", { name: "Download code package" })
    .last();
  await expect(download).toBeVisible();
  const response = await page.request.get(
    (await download.getAttribute("href")) ?? "",
  );
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/x-tar");
  expect((await response.body()).length).toBeGreaterThan(1024);
  await page
    .getByRole("button", { name: "Approve exact code package" })
    .click();
  await expect(
    page.getByText(
      "The exact code package was approved. No merge or deployment occurred.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".task-toolbar").getByText("DONE", { exact: true }),
  ).toBeVisible();
});
