import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openProjectPage, openTooltip, resetMock } from "./fixtures";

// Actions (docs/notes/actions-2-gui.md): the Projects page row's actions menu (the thread
// header's Play menu is gone, docs/notes/thread-header-crumb.md), the thread info card's
// action row, the editor dialog, and a run's bottom-panel tab with its command echo and
// status line. Mock seeds
// (mock/actions.ts): code-foundry (s-1's project) has Dev (runs until stopped), Test
// (exits 1 after ~2.6 s), Check, Build, Install deps (on worktree create) and Debug daemon
// (ignores SIGHUP: Stop ends it with 137 after ~1.5 s); every other project has none. Set SHOTS=<dir> to save the notes' screenshots.

test.beforeEach(async () => {
  await resetMock();
});

/** A project's main worktree row's actions menu on the Projects page. */
const trigger = (page: Page, project = "repo-cf") => page.locator(`[data-nav-key^="pw:${project}::"]`).first().getByTestId("worktree-actions-menu");
const menu = (page: Page) => page.getByTestId("worktree-actions-menu-menu");
const card = (page: Page) => page.getByTestId("thread-info-card");
const items = (page: Page) => menu(page).getByTestId("action-item");
const item = (page: Page, name: string) => items(page).filter({ hasText: name });
const dialog = (page: Page) => page.getByTestId("action-dialog");
const bottom = (page: Page) => page.getByTestId("bottom-panel");
const status = (page: Page) => page.getByTestId("action-status");

async function openMenu(page: Page, project = "repo-cf"): Promise<void> {
  await openApp(page);
  await openProjectPage(page, project);
  await trigger(page, project).hover();
  await trigger(page, project).click();
  await expect(menu(page)).toBeVisible();
}

/** The selected thread's card, its action row's menu open (its ellipsis). */
async function openCardActions(page: Page): Promise<void> {
  if ((await page.getByTestId("thread-info-toggle").getAttribute("aria-pressed")) !== "true") await page.getByTestId("thread-info-toggle").click();
  await card(page).getByTestId("ti-action-more").click();
  await expect(page.getByTestId("ti-action-menu")).toBeVisible();
}

/** Runs an action from the thread info card's action menu and waits for its tab to be the active one. */
async function runFromMenu(page: Page, name: string): Promise<string> {
  await openCardActions(page);
  await page.getByTestId("ti-action-item").filter({ hasText: name }).click();
  await expect(page.getByTestId("ti-action-menu")).toHaveCount(0);
  const tab = bottom(page).locator('[data-kind="action"]').filter({ hasText: name }).last();
  await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  return (await tab.getAttribute("data-tab-id")) ?? "";
}

// The menu's project label, items, New action and the pencil's label: src/components/actions/ActionsMenu.test.tsx.
test("a project page row's actions menu: the project's actions, a pencil on the highlighted row, Escape through its tooltip", async ({ page }) => {
  await openMenu(page);
  // The pencil shows on the highlighted row only.
  const pencil = (name: string) => item(page, name).getByTestId("action-edit");
  await item(page, "Test").hover();
  await expect(pencil("Test")).toHaveCSS("opacity", "1");
  await expect(pencil("Dev")).toHaveCSS("opacity", "0");
  // The pencil's tooltip opens inside the menu; Escape closes the tooltip and then the
  // menu under it (the tooltip must not swallow it), and the menu opens again.
  await pencil("Test").hover();
  await expect(openTooltip(page)).toHaveText("Edit Test");
  await page.keyboard.press("Escape");
  await expect(openTooltip(page)).toHaveCount(0);
  await expect(menu(page)).toHaveCount(0);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
});

// The card's action menu and a run's tab (its echo, Running, the failure, Rerun, no exit overlay, no
// toast): src/components/threadinfo/PlaceGroup.actions.test.tsx, src/components/bottom/BottomPanel.test.tsx
// ("an action run's tab"), src/components/actions/ActionRunDialog.test.tsx (a user's run does not toast).
// A project without actions, the icon tiles, add/edit/delete and a checkout row's run and the project
// menu's New action: src/components/actions/ActionsMenu.test.tsx and ActionDialog.test.tsx.
// Stop, Rerun, ×, Stop on a run that ignores SIGHUP, and an agent's run: BottomPanel.test.tsx.

// The toast, Open selecting the thread, the dialog's heading, meta, output and Run in terminal, a
// passing setup staying quiet and the failure toast's ×: src/components/actions/ActionRunDialog.test.tsx.
test("a failed worktree-create run's output at a narrow window: the meta on one line, the path giving way in the middle", async ({ page }) => {
  await openApp(page);
  await mockPost("action/setup?thread=s-1&code=1");
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Setup action Install deps failed (exit 1)" });
  await toast.getByRole("button", { name: "Open" }).click();
  const out = page.getByTestId("action-run-dialog");
  await expect(out.getByTestId("action-run-output")).not.toBeEmpty();
  // Narrow: the status stays on one line and the path gives way in the middle, keeping its
  // last folder (the worktree's branch folder) whole.
  await page.setViewportSize({ width: 360, height: 800 });
  const meta = out.getByTestId("action-run-meta");
  await expect.poll(async () => (await meta.boundingBox())?.height ?? 0).toBeLessThan(24);
  const tail = out.getByTestId("action-run-path").locator("span").last();
  await expect(tail).toHaveText("code-foundry");
  expect(await tail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await out.getByTestId("action-run-path").locator("span").first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
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

      await trigger(page, "repo-gp").click();
      await settle();
      await page.screenshot({ path: `${dir}/menu-empty-${scheme}.png` });
      await page.keyboard.press("Escape");
      await expect(menu(page)).toHaveCount(0);

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
      await settle();
      await page.screenshot({ path: `${dir}/dialog-edit-${scheme}.png` });
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
