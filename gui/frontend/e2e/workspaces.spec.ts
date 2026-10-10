import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, mockUrl, openApp, resetMock } from "./fixtures";

/** Where the mock (like the daemon) puts a repo's worktree for a cf/<name> branch. */
const WT = "/Users/dev/.code-foundry/worktrees/alexwaumann";
const GP_LOGIN = `${WT}/ghostty-playground/cf-login`;

interface SessionSummary {
  id: string;
  repoId: string;
  worktreePath: string;
  workspaceId: string;
}

interface WorkspaceSummary {
  id: string;
  name: string;
  branch: string;
  members: { repoId: string; worktreePath: string }[];
}

async function sessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${mockUrl}/__mock/sessions`);
  return (await res.json()) as SessionSummary[];
}

async function workspaces(): Promise<WorkspaceSummary[]> {
  const res = await fetch(`${mockUrl}/__mock/workspaces`);
  return (await res.json()) as WorkspaceSummary[];
}

test.beforeEach(async () => {
  await resetMock();
});

/** The member chips: repo id, primary flag and visible text, in order. */
function chips(page: Page) {
  return page.getByTestId("composer-member");
}

async function lastNewThread(): Promise<Record<string, string>> {
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  return (await invocations()).at(-1)?.args ?? {};
}

test("pick a workspace: member chips, the primary is changeable, the thread is the workspace's", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  // Workspaces above projects; projects keep cmd+1..9.
  const options = palette.getByRole("option");
  await expect(options.first()).toHaveAttribute("data-workspace", "w-000000000001");
  await expect(options.first()).toContainText("login");
  await expect(options.first().getByTestId("workspace-detail")).toHaveText("cf/login · code-foundry, ghostty-playground");
  await expect(palette.locator("[data-project]")).toHaveCount(4);
  await expect(palette.locator("[cmdk-group-heading]")).toHaveText(["Workspaces", "Projects"]);
  await expect(page.getByPlaceholder("Search workspaces and projects…")).toBeFocused();
  // Nothing in context: the first row (the workspace) is highlighted; Enter picks it.
  await expect(options.first()).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in login?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-repo", "repo-cf");
  await expect(chips(page).nth(0)).toHaveAttribute("data-primary", "true");
  await expect(chips(page).nth(0)).toContainText("code-foundry");
  await expect(chips(page).nth(0)).toContainText("cf/login");
  await expect(chips(page).nth(0)).toContainText("primary");
  await expect(chips(page).nth(1)).toContainText("ghostty-playground");
  await expect(chips(page).nth(1)).not.toHaveAttribute("data-primary");
  // Members are fixed for a workspace: no remove, no "Also in".
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByTestId("composer-also-in")).toHaveCount(0);
  await expect(page.getByTestId("composer-worktree")).toHaveText("Workspace worktrees");
  await expect(page.getByTestId("composer-checkout-branch")).toHaveText("On cf/login");
  await expect(page.getByTestId("composer-base")).toHaveCount(0);

  // The chips sit before the prompt in the Tab cycle.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "ghostty-playground on cf/login" })).toBeFocused();
  await page.keyboard.press("Enter"); // make it primary
  await expect(chips(page).nth(1)).toHaveAttribute("data-primary", "true");
  await expect(chips(page).nth(0)).not.toHaveAttribute("data-primary");
  await expect(page.getByRole("button", { name: "ghostty-playground on cf/login, primary: the thread runs here" })).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Wire the login form to the new API");
  await page.keyboard.press("Enter");

  expect(await lastNewThread()).toEqual({
    repo: "repo-gp",
    workspace: "w-000000000001",
    worktree: GP_LOGIN,
    model: "opus",
    effort: "high",
    permission: "auto",
    prompt: "Wire the login form to the new API",
  });
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  const id = ((await created.getAttribute("data-row-key")) ?? "").slice(2);
  expect((await sessions()).find((s) => s.id === id)).toMatchObject({ repoId: "repo-gp", worktreePath: GP_LOGIN, workspaceId: "w-000000000001" });
  await expect(page.getByTestId("composer")).toHaveCount(0);
});

test("a workspace in new-worktree mode makes a new workspace with the same projects", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-workspace="w-000000000001"]').click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in login?");
  await page.keyboard.type("Rename the session cookie");

  const worktree = page.getByTestId("composer-worktree");
  await worktree.click();
  const options = page.getByTestId("composer-worktree-list").getByRole("option");
  await expect(options).toHaveText([/^Workspace worktrees\s*cf\/login in 2 projects/, /^New worktree\s*A cf\/… branch in every project \(a new workspace\)/]);
  await options.filter({ hasText: "New worktree" }).click();
  await expect(worktree).toHaveText("New worktree");
  await expect(chips(page).nth(0)).toContainText("cf/…");
  await expect(page.getByTestId("composer-checkout-branch")).toHaveCount(0);
  await expect(page.getByTestId("composer-base")).toHaveText("From origin/main");

  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("composer-send")).toHaveText("Creating worktrees…");
  expect(await lastNewThread()).toEqual({
    repo: "repo-cf",
    "new-worktree": "true",
    repos: "repo-cf,repo-gp",
    model: "opus",
    effort: "high",
    permission: "auto",
    prompt: "Rename the session cookie",
  });
  await expect(page.locator('[data-row-kind="session"][aria-selected="true"]')).toBeVisible();
  await expect.poll(async () => (await workspaces()).map((w) => w.name)).toEqual(["login", "rename-the-session-cookie"]);
});

test("pick a project, add Also in: a new workspace with a cf/<slug> worktree in each", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  // A project alone: no chips, only "Also in…".
  await expect(chips(page)).toHaveCount(0);
  const alsoIn = page.getByTestId("composer-also-in");
  await expect(alsoIn).toHaveText("Also in…");
  await expect(page.getByTestId("composer-worktree")).toHaveText("New worktree");

  // Choose an existing worktree first: Also in overrides it (new worktrees only).
  await page.getByTestId("composer-worktree").click();
  await page.getByTestId("composer-worktree-list").getByRole("option").filter({ hasText: "feat/sidebar" }).click();
  await expect(page.getByTestId("composer-worktree")).toHaveText("Existing worktree: feat/sidebar");

  await alsoIn.click();
  const projects = page.getByTestId("composer-also-in-list").getByRole("option");
  await expect(projects).toHaveText([/^dotfiles/, /^ghostty-playground/, /^sketches/]);
  await page.keyboard.type("ghostty");
  await page.keyboard.press("Enter");
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-primary", "true");
  await expect(chips(page).nth(0)).toContainText("code-foundry");
  await expect(chips(page).nth(1)).toContainText("ghostty-playground");
  await expect(chips(page).nth(1)).toContainText("cf/…");
  await expect(alsoIn).toHaveText("Add project");
  await expect(page.getByTestId("composer-worktree")).toHaveText("New worktree");
  await page.getByTestId("composer-worktree").click();
  await expect(page.getByTestId("composer-worktree-list").getByRole("option")).toHaveText([/^New worktree\s*A cf\/… branch in every project/]);
  await page.keyboard.press("Escape");

  // A third one, removed again; the project itself cannot be removed.
  await alsoIn.click();
  await page.getByTestId("composer-also-in-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await expect(chips(page)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Remove code-foundry" })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove sketches" }).click();
  await expect(chips(page)).toHaveCount(2);

  // The base picker is the primary's: ghostty-playground as primary shows its default,
  // then back to code-foundry with a picked base.
  await chips(page).nth(1).getByRole("button", { name: /^ghostty-playground/ }).click();
  await expect(chips(page).nth(1)).toHaveAttribute("data-primary", "true");
  await expect(page.getByTestId("composer-base")).toHaveText("From origin/main");
  await chips(page).nth(0).getByRole("button", { name: /^code-foundry/ }).click();
  await page.getByTestId("composer-base").click();
  await page.keyboard.type("release");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-base")).toHaveText("From origin/release/v0.3");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Add a dark mode toggle");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-send")).toHaveText("Creating worktrees…");
  expect(await lastNewThread()).toEqual({
    repo: "repo-cf",
    "new-worktree": "true",
    repos: "repo-cf:origin/release/v0.3,repo-gp",
    model: "opus",
    effort: "high",
    permission: "auto",
    prompt: "Add a dark mode toggle",
  });
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  const id = ((await created.getAttribute("data-row-key")) ?? "").slice(2);
  await expect.poll(workspaces).toHaveLength(1);
  const [ws] = await workspaces();
  expect(ws).toMatchObject({ name: "add-a-dark-mode", branch: "cf/add-a-dark-mode" });
  expect(ws?.members.map((m) => m.repoId)).toEqual(["repo-cf", "repo-gp"]);
  expect((await sessions()).find((s) => s.id === id)).toMatchObject({ repoId: "repo-cf", workspaceId: ws?.id, worktreePath: `${WT}/code-foundry/cf-add-a-dark-mode` });

  // The new workspace is in the picker now; the project's draft is clear again.
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette").locator(`[data-workspace="${ws?.id ?? ""}"]`)).toContainText("add-a-dark-mode");
  await page.keyboard.press("Meta+1");
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-also-in")).toHaveText("Also in…");
});

test("with workspaces around, a single-project thread sends exactly what it did before", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+3"); // projects keep cmd+1..9: ghostty-playground
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await page.keyboard.type("Port the renderer");
  await page.keyboard.press("Enter");
  expect(await lastNewThread()).toEqual({
    repo: "repo-gp",
    "new-worktree": "true",
    base: "origin/main",
    model: "opus",
    effort: "high",
    permission: "auto",
    prompt: "Port the renderer",
  });
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  const id = ((await created.getAttribute("data-row-key")) ?? "").slice(2);
  expect((await sessions()).find((s) => s.id === id)?.workspaceId).toBe("");
  expect(await workspaces()).toHaveLength(1);
});

test("a workspace removed while its composer is open says so", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in login?");
  await mockPost("reset");
  await expect(page.getByTestId("composer")).toHaveText("This workspace no longer exists.");
});
