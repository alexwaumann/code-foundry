import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, openProjects, resetMock, row } from "./fixtures";

// Every way to start a shell lands in a bottom panel (docs/notes/bottom-panel-3-routing.md):
// the thread's when a thread owns it, else the Projects page's. The sidebar never gets a row.

/** Where the mock (like the daemon) puts a repo's worktree for the cf/checkout branch. */
const CF_MEMBER = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-checkout";
const WS = "w-000000000001";

const bottom = (page: Page) => page.getByTestId("bottom-panel");
const host = (page: Page) => page.getByTestId("bottom-terminal-host");

async function lastNew() {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "terminal.new").length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === "terminal.new").at(-1);
}

async function shellLabels(page: Page, id: string): Promise<Record<string, string>> {
  return page.evaluate(`import("/src/stores/terminals.ts").then((m) => m.useTerminalsStore.getState().byId[${JSON.stringify(id)}]?.labels ?? {})`);
}

async function noTerminalRows(page: Page): Promise<void> {
  await expect(page.getByTestId("thread-list").locator('[data-row-kind]:not([data-row-kind="session"]):not([data-row-kind="header"])')).toHaveCount(0);
}

test.beforeEach(async () => {
  await resetMock();
});

test("a thread row's New terminal here: the thread owns the shell, in its bottom panel", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  // s-2 is not selected: its panel opens on the shell, the selection stays.
  await row(page, "s:s-2").click({ button: "right" });
  await page.getByTestId("row-menu").getByText("New terminal here").click();
  expect((await lastNew())?.context).toMatchObject({ activeSessionId: "s-2", activeView: "session" });
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
  await noTerminalRows(page);
  await row(page, "s:s-2").click();
  await expect(bottom(page).getByRole("tab")).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  const id = (await host(page).getAttribute("data-terminal-id")) ?? "";
  expect(await shellLabels(page, id)).toMatchObject({ kind: "shell", session: "s-2" });

  // s-1 has t-s1-shell already: a second tab.
  await row(page, "s:s-1").click({ button: "right" });
  await page.getByTestId("row-menu").getByText("New terminal here").click();
  await row(page, "s:s-1").click();
  await expect(bottom(page).getByRole("tab")).toHaveCount(2);
});

test("cmd+t on a thread starts its shell in the bottom panel, with the keyboard in it", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await page.keyboard.press("Meta+t");
  await expect(bottom(page).getByRole("tab")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("bottom");
  expect((await lastNew())?.context).toMatchObject({ activeSessionId: "s-2" });
  await noTerminalRows(page);
  // The new tab is the feedback: no "created terminal" toast.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("a workspace member's New terminal here in a thread's side panel: the thread owns it, in the member's worktree", async ({ page }) => {
  await mockPost("workspace-mixed?name=checkout");
  const driver = ((await mockPost("workspace-thread?workspace=checkout&repo=repo-gp&name=driver")) as { id: string }).id;
  await openApp(page);
  await row(page, `s:${driver}`).getByTestId("row-workspace").click();
  const cf = page.getByTestId("workspace-surface").locator(`[data-nav-key="m:${WS}::repo-cf"]`);
  await cf.hover();
  await cf.getByTestId("member-terminal").click();
  const call = await lastNew();
  expect(call?.args).toEqual({ cwd: CF_MEMBER });
  expect(call?.context).toMatchObject({ activeSessionId: driver, activeView: "session" });
  // The thread's bottom panel, not the Projects page's.
  await expect(row(page, `s:${driver}`)).toHaveAttribute("aria-selected", "true");
  await expect(bottom(page).getByRole("tab")).toHaveCount(1);
  const id = (await host(page).getAttribute("data-terminal-id")) ?? "";
  expect(await shellLabels(page, id)).toMatchObject({ kind: "shell", session: driver });
  await expect(bottom(page).getByRole("tab")).toHaveAttribute("title", "~/.code-foundry/worktrees/alexwaumann/code-foundry/cf-checkout");
});

test("a member's New terminal here from an expanded side panel collapses it so the shell shows", async ({ page }) => {
  await mockPost("workspace-mixed?name=checkout");
  const driver = ((await mockPost("workspace-thread?workspace=checkout&repo=repo-gp&name=driver")) as { id: string }).id;
  await openApp(page);
  await row(page, `s:${driver}`).getByTestId("row-workspace").click();
  const side = page.getByTestId("side-panel");
  await side.getByTestId("panel-header").getByTestId("panel-expand").click();
  await expect(side.getByTestId("panel-header").getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("content-pane")).toBeHidden();
  const cf = page.getByTestId("workspace-surface").locator(`[data-nav-key="m:${WS}::repo-cf"]`);
  await cf.hover();
  await cf.getByTestId("member-terminal").click();
  // The side panel is back to its split width, and the new shell shows, with the keyboard.
  await expect(side.getByTestId("panel-header").getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("content-pane")).toBeVisible();
  await expect(bottom(page).getByRole("tab")).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("bottom");
});

test("cmd+t from a Projects-page shell starts another in its worktree", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await page.keyboard.press("Meta+j");
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-top");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("bottom");
  await page.keyboard.press("Meta+t");
  expect((await lastNew())?.context).toMatchObject({ activeTerminalId: "t-top", activeRepoId: "repo-cf", activeWorktreePath: `${CF}.worktrees/feat-sidebar`, activeView: "projects" });
  await expect(bottom(page).getByRole("tab")).toHaveText(["feat-sidebar", "feat-sidebar 2"]);
  await expect(bottom(page).getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("bottom");
});

test("a project row's New terminal: the Projects page's bottom panel", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const cf = page.locator('[data-nav-key="p:repo-cf"]');
  await cf.hover();
  await cf.getByTestId("project-new-terminal").click();
  expect((await lastNew())?.context).toMatchObject({ activeRepoId: "repo-cf", activeWorktreePath: CF, activeSessionId: "" });
  // t-top (feat/sidebar) and the new one (main).
  await expect(bottom(page).getByRole("tab")).toHaveText(["feat-sidebar", "code-foundry"]);
  await expect(bottom(page).getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await noTerminalRows(page);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

/** SHOTS=<dir>: the notes' screenshots (docs/notes/bottom-panel-3-routing/), WebKit, 1440x900 at 2x. */
test.describe("screenshots", () => {
  test.use({ deviceScaleFactor: 2 });
  for (const scheme of ["dark", "light"] as const) {
    test(`screenshots (${scheme})`, async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const shot = (name: string) => page.screenshot({ path: `${String(shots)}/${name}-${scheme}.png` });
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await openApp(page);

      // A thread with two shells: t-s1-shell and one from its row menu, the second active.
      await row(page, "s:s-1").click();
      await row(page, "s:s-1").click({ button: "right" });
      await page.getByTestId("row-menu").getByText("New terminal here").click();
      await expect(bottom(page).getByRole("tab")).toHaveCount(2);
      await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
      await page.keyboard.type("git status");
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
      await shot("thread");
      await page.getByTestId("sidebar").screenshot({ path: `${String(shots)}/sidebar-${scheme}.png` });

      // The Projects page: t-top, and a shell from dotfiles' row.
      await openProjects(page);
      const dot = page.locator('[data-nav-key="p:repo-dot"]');
      await dot.hover();
      await dot.getByTestId("project-new-terminal").click();
      await expect(bottom(page).getByRole("tab")).toHaveCount(2);
      await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
      await shot("projects");
    });
  }
});
