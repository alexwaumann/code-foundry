import { expect, test, type Page } from "@playwright/test";
import { appPath, mockUrl, resetMock, threadsOpenAsTabs } from "./fixtures";

/**
 * Plugin surfaces in a pane's "+" menu (docs/notes/plus-menu-plugins.md), against the mock's
 * layout: a pick runs the surface's show command with --pane and the mock daemon's layout opens
 * its tab in that pane, which the window then shows. Which surfaces are listed, where, and which
 * verb each pick runs are vitest's (components/shell/plusPlugins.test.tsx). SHOTS=<dir> for the
 * PR's screenshots (WebKit, 1400x900, dark and light).
 */

type Node = { t: "pane"; id: string; tabs: Record<string, unknown>[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string) => ({ id: `t-${id}`, kind: "thread", thread: id });
const prs = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const pane = (id: string, tabs: Record<string, unknown>[], active = String(tabs[0]?.id)): Node => ({ t: "pane", id, tabs, active });
const LAYOUT: Node = { t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1")]), pane("p-2", [prs])], sizes: [0.55, 0.45] };

async function seed(root: Node, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(LAYOUT, "p-1");
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
const activeKind = (page: Page, id: string) => paneEl(page, id).locator('[data-testid="shell-tab"][data-active]').getAttribute("data-kind");

/** The page's finite animations (a menu's fade and zoom in) have finished. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test.beforeEach(async () => {
  await resetMock();
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
});

test("a plugin surface picked in a pane's + opens as a tab in that pane", async ({ page }) => {
  await openShell(page);
  await paneEl(page, "p-2").getByTestId("pane-plus").click();
  await page.getByTestId("pane-plus-menu").locator('[data-kind="plugin.test-watcher.runs"]').click();
  await expect.poll(() => activeKind(page, "p-2")).toBe("plugin.test-watcher.runs");
  await expect(paneEl(page, "p-2").getByTestId("plugin-title")).toHaveText("Test runs");

  // A thread's surface, from the thread's submenu in the other pane: linked to it, in that pane.
  await paneEl(page, "p-1").getByTestId("pane-plus").click();
  await page.getByTestId("plus-thread").hover();
  await page.getByTestId("plus-thread-surfaces").locator('[data-kind="plugin.hello.demo"]').click();
  await expect.poll(() => activeKind(page, "p-1")).toBe("plugin.hello.demo");
});

/** SHOTS=<dir>: the + menu without a thread and its thread submenu, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`plus menu plugin screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await openShell(page);
    const clip = { x: 0, y: 0, width: 1400, height: 520 };

    await paneEl(page, "p-1").getByTestId("pane-plus").click();
    await page.getByTestId("plus-thread").hover();
    await expect(page.getByTestId("plus-thread-surfaces")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("plus-thread"), clip });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pane-plus-menu")).toHaveCount(0);

    await paneEl(page, "p-2").getByTestId("pane-plus").click();
    await expect(page.getByTestId("pane-plus-menu")).toBeVisible();
    await page.mouse.move(1390, 890);
    await still(page);
    await page.screenshot({ path: at("plus-general"), clip });
  });
}
