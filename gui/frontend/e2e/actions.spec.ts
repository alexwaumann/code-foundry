import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, mockUrl, openApp, openProjects, resetMock, row } from "./fixtures";

// Actions (docs/notes/actions-2-gui.md): the thread header's Play menu, the editor dialog,
// and a run's bottom-panel tab with its command echo and status line. Mock seeds
// (mock/actions.ts): code-foundry (s-1's project) has Dev (runs until stopped), Test
// (exits 1 after ~2.6 s), Check, Build, Install deps (on worktree create) and Debug daemon;
// every other project has none. Set SHOTS=<dir> to save the notes' screenshots.

const IDS = { dev: "a-dev000000000", test: "a-test00000000", build: "a-build0000000" };
const NAMES = ["Dev", "Test", "Check", "Build", "Install deps", "Debug daemon"];

test.beforeEach(async () => {
  await resetMock();
});

const trigger = (page: Page) => page.getByTestId("thread-header").getByTestId("pane-actions-menu");
const menu = (page: Page) => page.getByTestId("pane-actions-menu-menu");
const items = (page: Page) => menu(page).getByTestId("action-item");
const item = (page: Page, name: string) => items(page).filter({ hasText: name });
const dialog = (page: Page) => page.getByTestId("action-dialog");
const bottom = (page: Page) => page.getByTestId("bottom-panel");
const tabs = (page: Page) => bottom(page).getByRole("tab");
const host = (page: Page) => page.getByTestId("bottom-terminal-host");
const status = (page: Page) => page.getByTestId("action-status");

async function selectSession(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

async function openMenu(page: Page, session = "s-1"): Promise<void> {
  await openApp(page);
  await selectSession(page, session);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
}

async function calls(name: string) {
  return (await invocations()).filter((i) => i.name === name);
}

/** The action ids of a project, in list order (GET /__mock/actions). */
async function actionsOf(repoId: string): Promise<{ id: string; name: string; command: string; icon: string; onWorktreeCreate?: boolean }[]> {
  const res = await fetch(`${mockUrl}/__mock/actions`);
  const body = (await res.json()) as { actions: { id: string; repoId: string; name: string; command: string; icon: string; onWorktreeCreate?: boolean }[] };
  return body.actions.filter((a) => a.repoId === repoId);
}

/** Runs an action from the header menu and waits for its tab to be the active one. */
async function runFromMenu(page: Page, name: string): Promise<string> {
  await trigger(page).click();
  await item(page, name).click();
  await expect(menu(page)).toHaveCount(0);
  const tab = bottom(page).locator('[data-kind="action"]').filter({ hasText: name }).last();
  await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  return (await tab.getAttribute("data-tab-id")) ?? "";
}

test("the header's Play menu lists the project's actions and runs one in the thread's bottom panel", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  // Left of the bottom panel's toggle.
  await expect(page.getByTestId("thread-header").locator('[data-testid="pane-actions-menu"] + [data-testid="bottom-toggle"]')).toHaveCount(1);
  await expect(trigger(page)).toHaveAttribute("title", "Run an action");
  await trigger(page).click();
  await expect(menu(page).getByTestId("actions-project")).toHaveText("code-foundry");
  await expect(items(page)).toHaveText(NAMES);
  await expect(menu(page).getByTestId("action-new")).toHaveText("New action…");

  // The pencil shows on the highlighted row only.
  const pencil = (name: string) => item(page, name).getByTestId("action-edit");
  await item(page, "Test").hover();
  await expect(pencil("Test")).toHaveCSS("opacity", "1");
  await expect(pencil("Dev")).toHaveCSS("opacity", "0");
  await expect(pencil("Test")).toHaveAttribute("aria-label", "Edit Test");

  // A click runs it for the thread, always in a terminal, without a toast.
  await item(page, "Test").click();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(async () => (await calls("action.run")).map((c) => [c.args, c.context?.activeSessionId])).toEqual([[{ action: IDS.test, terminal: "true" }, "s-1"]]);
  await expect(bottom(page)).toBeVisible();
  await expect(tabs(page)).toHaveText(["code-foundry", "Test"]);
  const tab = bottom(page).locator('[data-kind="action"]');
  await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  const id = (await tab.getAttribute("data-tab-id")) ?? "";
  await expect(host(page)).toHaveAttribute("data-terminal-id", id);
  // The command, dimmed, above the output; the status line under it from the start.
  await expect(page.getByTestId("action-echo")).toHaveText("$ go test ./...");
  await expect(tab.getByTestId("action-tab-status")).toHaveAttribute("data-status", "running");
  await expect(status(page)).toHaveAttribute("data-status", "running");
  await expect(status(page)).toContainText("Running");
  await expect(status(page).getByTestId("action-status-time")).toHaveText(/^0:0\d$/);
  await expect(page.getByTestId("action-stop")).toBeVisible();
  // The test fails: red x on the tab, the status line says so in red, with Rerun; no exit overlay.
  await expect(tab.getByTestId("action-tab-status")).toHaveAttribute("data-status", "failed", { timeout: 8000 });
  await expect(status(page)).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("action-status-label")).toHaveText("Exited with code 1");
  await expect(status(page).getByTestId("action-status-time")).toHaveText(/^\d\.\ds$/);
  await expect(page.getByTestId("action-rerun")).toBeVisible();
  await expect(page.getByTestId("exit-overlay")).toHaveCount(0);
  // No toast for it. A failing setup run follows (events arrive in order): once its toast
  // shows, this run's run_finished was seen, and the toasts are counted at once (a retrying
  // toHaveCount(0) would wait out a toast's own dismissal).
  await mockPost("action/setup?session=s-1&code=2&action=Build");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Setup action Build failed (exit 2)" })).toBeVisible();
  expect(await page.locator("[data-sonner-toast]").count()).toBe(1);
});

test("a project without actions: the empty state and New action…", async ({ page }) => {
  await openMenu(page, "s-2");
  await expect(menu(page).getByTestId("actions-empty")).toHaveText("No actions for ghostty-playground yet");
  await expect(items(page)).toHaveCount(0);
  await menu(page).getByTestId("action-new").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("data-mode", "new");
  await expect(dialog(page)).toContainText("Saved for every thread in ghostty-playground.");
  await expect(dialog(page).getByTestId("action-name")).toBeFocused();
});

test("add, then edit (pencil and ArrowRight), then delete an action", async ({ page }) => {
  await openMenu(page);
  await menu(page).getByTestId("action-new").click();
  await expect(dialog(page)).toHaveAttribute("data-mode", "new");
  await expect(dialog(page).getByRole("heading", { name: "New action" })).toBeVisible();
  const save = dialog(page).getByTestId("action-save");
  await expect(save).toBeDisabled();
  await dialog(page).getByTestId("action-name").fill("Lint");
  await expect(save).toBeDisabled();
  await dialog(page).getByTestId("action-command").fill("golangci-lint run\nstaticcheck ./...");
  await dialog(page).locator('[data-testid="action-icon"][data-icon="lint"]').click();
  await expect(dialog(page).locator('[data-testid="action-icon"][aria-checked="true"]')).toHaveAttribute("data-icon", "lint");
  await dialog(page).getByTestId("action-on-create").click();
  await expect(dialog(page).getByTestId("action-on-create")).toHaveAttribute("aria-checked", "true");
  await save.click();
  await expect(dialog(page)).toHaveCount(0);
  const [add] = await calls("action.add");
  expect(add?.args).toEqual({ name: "Lint", command: "golangci-lint run\nstaticcheck ./...", icon: "lint", "in-terminal": "true", "on-worktree-create": "true", repo: "repo-cf" });
  await trigger(page).click();
  await expect(items(page)).toHaveText([...NAMES, "Lint"]);
  await page.keyboard.press("Escape");
  // Gone (it fades out) before the next click opens it again.
  await expect(menu(page)).toHaveCount(0);

  // A name the project has (ignoring case): the daemon's refusal, in place.
  await trigger(page).click();
  await menu(page).getByTestId("action-new").click();
  await dialog(page).getByTestId("action-name").fill("test");
  await dialog(page).getByTestId("action-command").fill("true");
  await dialog(page).getByTestId("action-save").click();
  // Without the store's "failed precondition: " (the mock sends it like the daemon).
  await expect(dialog(page).getByTestId("action-error")).toHaveText('this project already has an action named "Test"');
  await expect(dialog(page).getByTestId("action-name")).toHaveAttribute("aria-invalid", "true");
  // A toast would come from the same failure as the inline line: counted at once, not retried.
  expect(await page.locator("[data-sonner-toast]").count()).toBe(0);
  await dialog(page).getByTestId("action-cancel").click();
  await expect(dialog(page)).toHaveCount(0);

  // The pencil edits; only what changed is sent.
  const lint = (await actionsOf("repo-cf")).find((a) => a.name === "Lint");
  expect(lint).toBeDefined();
  await trigger(page).click();
  await item(page, "Lint").hover();
  await item(page, "Lint").getByTestId("action-edit").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(calls("action.run")).resolves.toHaveLength(0);
  await expect(dialog(page)).toHaveAttribute("data-mode", "edit");
  await expect(dialog(page).getByTestId("action-name")).toHaveValue("Lint");
  await expect(dialog(page).getByTestId("action-command")).toHaveValue("golangci-lint run\nstaticcheck ./...");
  await dialog(page).getByTestId("action-command").fill("make lint");
  // Cmd+Enter saves.
  await dialog(page).getByTestId("action-command").press("ControlOrMeta+Enter");
  await expect(dialog(page)).toHaveCount(0);
  const [edit] = await calls("action.edit");
  expect(edit?.args).toEqual({ action: lint?.id, command: "make lint", repo: "repo-cf" });

  // ArrowRight on a highlighted row is the pencil's keyboard path.
  await trigger(page).click();
  await item(page, "Lint").hover();
  await page.keyboard.press("ArrowRight");
  await expect(dialog(page)).toHaveAttribute("data-mode", "edit");
  await expect(dialog(page).getByTestId("action-command")).toHaveValue("make lint");

  // Delete asks in the footer; Keep goes back, Delete (on the right) deletes.
  await dialog(page).getByTestId("action-delete").click();
  const confirm = dialog(page).getByTestId("action-delete-confirm");
  await expect(confirm).toContainText("Delete Lint for every thread in code-foundry?");
  await expect(dialog(page).getByTestId("action-save")).toHaveCount(0);
  // The keyboard follows the swap: to Keep, and back to Delete.
  await expect(confirm.getByTestId("action-delete-keep")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveCount(0);
  await expect(dialog(page).getByTestId("action-delete")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm.getByTestId("action-delete-keep")).toBeFocused();
  await dialog(page).getByTestId("action-delete-yes").click();
  await expect(dialog(page)).toHaveCount(0);
  const [remove] = await calls("action.remove");
  expect(remove?.args).toEqual({ action: lint?.id, repo: "repo-cf" });
  await trigger(page).click();
  await expect(items(page)).toHaveText(NAMES);
});

test("an action tab: Stop keeps the tab exited, Rerun replaces it with a new run, × closes it", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  const dev = await runFromMenu(page, "Dev");
  await expect(page.getByTestId("action-echo")).toHaveText("$ pnpm dev");
  await expect(status(page)).toHaveAttribute("data-status", "running");
  await page.getByTestId("action-stop").click();
  await expect.poll(async () => (await calls("terminal.kill")).map((c) => [c.args, c.confirmed])).toEqual([[{ id: dev }, true]]);
  await expect(status(page)).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("action-status-label")).toHaveText("Exited with code 129");
  await expect(bottom(page).locator(`[data-tab-id="${dev}"]`)).toHaveCount(1);

  // Rerun: a new run of the same action for the same thread; the old tab goes, the new one is active.
  await page.getByTestId("action-rerun").click();
  await expect.poll(async () => (await calls("action.run")).length).toBe(2);
  await expect(bottom(page).locator(`[data-tab-id="${dev}"]`)).toHaveCount(0);
  const rerun = bottom(page).locator('[data-kind="action"]');
  await expect(rerun).toHaveCount(1);
  const fresh = (await rerun.getAttribute("data-tab-id")) ?? "";
  expect(fresh).not.toBe(dev);
  await expect(rerun.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect(host(page)).toHaveAttribute("data-terminal-id", fresh);
  await expect(status(page)).toHaveAttribute("data-status", "running");
  const [, again] = await calls("action.run");
  expect(again?.args).toEqual({ action: IDS.dev, terminal: "true" });
  expect(again?.context?.activeSessionId).toBe("s-1");

  // A finished run that exits 0: the green check, the duration, Rerun.
  const build = await runFromMenu(page, "Build");
  const buildTab = bottom(page).locator(`[data-tab-id="${build}"]`);
  await expect(buildTab.getByTestId("action-tab-status")).toHaveAttribute("data-status", "ok", { timeout: 8000 });
  await expect(page.getByTestId("action-status-label")).toHaveText("Exited with code 0");
  await expect(status(page)).toHaveAttribute("data-status", "ok");

  // × closes it through terminal.close, like a shell's tab.
  await buildTab.getByRole("button", { name: "Close Build" }).click();
  await expect(buildTab).toHaveCount(0);
  expect((await calls("terminal.close")).map((c) => c.args.id)).toContain(build);
});

test("an action an agent ran shows up as a tab of its thread's panel", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await mockPost("action/run?session=s-1&action=Check");
  await expect(bottom(page)).toBeVisible();
  await expect(bottom(page).locator('[data-kind="action"]')).toHaveText("Check");
  await expect(page.getByTestId("action-echo")).toHaveText("$ make check");
});

test("the Projects page: a worktree row runs an action for that worktree; the project menu adds one", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const wtRow = page.locator(`[data-testid="project-worktree"][data-path="${CF}"]`).locator("xpath=..");
  await wtRow.hover();
  await wtRow.getByTestId("worktree-actions-menu").click();
  const rowMenu = page.getByTestId("worktree-actions-menu-menu");
  await expect(rowMenu.getByTestId("action-item")).toHaveText(NAMES);
  await rowMenu.getByTestId("action-item").filter({ hasText: "Build" }).click();
  await expect.poll(async () => (await calls("action.run")).map((c) => [c.args, c.context?.activeRepoId, c.context?.activeWorktreePath])).toEqual([[{ action: IDS.build, terminal: "true" }, "repo-cf", CF]]);
  await expect(bottom(page)).toBeVisible();
  await expect(bottom(page)).toHaveAttribute("data-panel-key", "view:projects");
  await expect(bottom(page).locator('[data-kind="action"]')).toHaveText("Build");
  await expect(page.getByTestId("action-echo")).toHaveText("$ make build");

  const project = page.locator('[data-testid="project"][data-repo="repo-gp"]');
  await project.getByTestId("project-more").click();
  await page.getByTestId("project-new-action").click();
  await expect(dialog(page)).toHaveAttribute("data-mode", "new");
  await expect(dialog(page)).toContainText("Saved for every thread in ghostty-playground. Runs in the worktree's checkout");
  await dialog(page).getByTestId("action-name").fill("Zig build");
  await dialog(page).getByTestId("action-command").fill("zig build");
  await dialog(page).getByTestId("action-save").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await actionsOf("repo-gp")).map((a) => a.name)).toEqual(["Zig build"]);
});

test("a failed worktree-create action toasts; Open selects the thread and shows the run's output", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await mockPost("action/setup?session=s-1&code=1");
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Setup action Install deps failed (exit 1)" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Open" }).click();
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
  const out = page.getByTestId("action-run-dialog");
  await expect(out).toBeVisible();
  await expect(out.getByRole("heading")).toHaveText("Setup action Install deps failed");
  await expect(out.getByTestId("action-run-meta")).toContainText("Exited with code 1");
  await expect(out.getByTestId("action-run-output")).not.toBeEmpty();
  // Run in terminal: the same action again for the thread, as a tab.
  await out.getByTestId("action-run-again").click();
  await expect(out).toHaveCount(0);
  await expect(bottom(page).locator('[data-kind="action"]')).toHaveText("Install deps");
  // A successful setup run stays quiet. Once it has finished, a failing one follows: events
  // arrive in order, so when that one's toast shows, the passing run's run_finished was seen.
  const passed = (await mockPost("action/setup?session=s-1&code=0")) as { id: string };
  await expect
    .poll(async () => {
      const res = await fetch(`${mockUrl}/__mock/actions`);
      const body = (await res.json()) as { runs: { id: string; state: string }[] };
      return body.runs.find((r) => r.id === passed.id)?.state;
    })
    .toBe("EXITED");
  await mockPost("action/setup?session=s-1&code=2&action=Build");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Setup action Build failed (exit 2)" })).toBeVisible();
  // Counted now, not retried: a retrying toHaveCount(0) would wait out the toast's own dismissal.
  expect(await page.locator("[data-sonner-toast]").filter({ hasText: "(exit 0)" }).count()).toBe(0);
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1280x800 at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("menu, empty menu, dialogs, running and exited tabs", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      test.setTimeout(60_000);
      const dir = String(shots);
      const settle = () => page.waitForTimeout(350);
      await openMenu(page);
      await item(page, "Test").hover();
      await settle();
      await page.screenshot({ path: `${dir}/menu-${scheme}.png` });
      await page.keyboard.press("Escape");
      await expect(menu(page)).toHaveCount(0);

      await selectSession(page, "s-2");
      await trigger(page).click();
      await settle();
      await page.screenshot({ path: `${dir}/menu-empty-${scheme}.png` });
      await page.keyboard.press("Escape");
      await expect(menu(page)).toHaveCount(0);

      await selectSession(page, "s-1");
      await trigger(page).click();
      await menu(page).getByTestId("action-new").click();
      await dialog(page).getByTestId("action-name").fill("Install deps");
      await dialog(page).getByTestId("action-command").fill("cd gui/frontend\npnpm install --frozen-lockfile");
      await dialog(page).locator('[data-testid="action-icon"][data-icon="configure"]').click();
      await dialog(page).getByTestId("action-on-create").click();
      await dialog(page).getByTestId("action-command").focus();
      await settle();
      await page.screenshot({ path: `${dir}/dialog-new-${scheme}.png` });
      await dialog(page).getByTestId("action-cancel").click();

      await trigger(page).click();
      await item(page, "Test").hover();
      await item(page, "Test").getByTestId("action-edit").click();
      await dialog(page).getByTestId("action-delete").click();
      await settle();
      await page.screenshot({ path: `${dir}/dialog-delete-${scheme}.png` });
      await dialog(page).getByTestId("action-delete-keep").click();
      await dialog(page).getByTestId("action-cancel").click();

      await runFromMenu(page, "Check");
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${dir}/panel-running-${scheme}.png` });
      await runFromMenu(page, "Test");
      await expect(status(page)).toHaveAttribute("data-status", "failed", { timeout: 8000 });
      await page.mouse.move(0, 0);
      await settle();
      await page.screenshot({ path: `${dir}/panel-exited-${scheme}.png` });
    });
  });
}
