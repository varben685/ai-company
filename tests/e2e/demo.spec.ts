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
test("DEMO: login → project → task → plan → changes → new plan → approve → reload", async ({
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
  await expect(page.getByText("DEMO — no live AI")).toBeVisible();
  await page.getByRole("link", { name: "Open projects" }).click();
  const name = "Notes acceptance " + Date.now();
  await page.getByLabel("Project name").fill(name);
  await page
    .getByLabel("Description", { exact: true })
    .fill(
      "Notes with title and content belong to the signed-in user. NestJS, Next.js, PostgreSQL.",
    );
  await page.getByText("Project context", { exact: false }).click();
  await page
    .getByLabel("Architecture", { exact: true })
    .fill("Strict TypeScript. Services use repositories.");
  await page
    .getByLabel("Security", { exact: true })
    .fill("Only a note owner may access or change the note.");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("link")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .click();
  await page.getByLabel("Task title").fill("Archive and restore notes");
  await page
    .getByLabel("What should change?")
    .fill(
      "Archive notes, hide archived notes in the default list, show an archived list and restore notes from it.",
    );
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page).toHaveURL(/tasks\//);
  await page.getByRole("button", { name: "Start planning" }).click();
  await expect(
    page.getByRole("button", { name: "Approve plan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Requirements", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Assumptions", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Decision comment")
    .fill("Archived notes must also be searchable by title.");
  await page
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve plan" }),
  ).toBeVisible();
  await expect(page.getByLabel("Plan version").locator("option")).toHaveCount(
    2,
  );
  await expect(page.getByLabel("Plan version")).toContainText(
    "Version 2 · Current",
  );
  await page.getByLabel("Plan version").selectOption({ label: "Version 1" });
  await expect(page.getByRole("button", { name: "Approve plan" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("CHANGES REQUESTED", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Plan version")
    .selectOption({ label: "Version 2 · Current" });
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(
    page.getByText(
      "Plan approved. Start development explicitly for a matching sample-todo-v1 project and feature.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".task-toolbar").getByText("PLAN APPROVED", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start development" }),
  ).toBeVisible();
  await expect(page.getByText("PLAN CREATED", { exact: true })).toHaveCount(2);
  await page.screenshot({
    path: ".local/demo-task-approved.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/login/);
});
