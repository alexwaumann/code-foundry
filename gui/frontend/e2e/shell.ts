import { expect, type Locator, type Page } from "@playwright/test";
import { appPath, mockUrl } from "./fixtures";

/**
 * Helpers for specs that reach a surface through the window shell (docs/notes/shell-model.md):
 * seeding the mock's layout, opening a thread's tab, a page's tab, a surface linked to a thread,
 * and finding panes and tabs. The classic side and bottom panels these specs once opened are gone
 * (docs/notes/shell-21-remove-classic.md). The shell-*.spec.ts files keep their own seeds.
 */

/** A layout node in internal/layout's JSON (mock/layout.ts Node). */
export type LayoutNode =
  | { t: "pane"; id: string; tabs: Record<string, unknown>[]; active: string }
  | { t: "split"; id: string; dir: "row" | "col"; kids: LayoutNode[]; sizes: number[] };

/** A thread's own tab. */
export const threadTab = (id: string): Record<string, unknown> => ({ id: `t-${id}`, kind: "thread", thread: id });
export const paneNode = (id: string, tabs: Record<string, unknown>[], active = String(tabs[0]?.id)): LayoutNode => ({ t: "pane", id, tabs, active });
export const rowNode = (kids: LayoutNode[], sizes = kids.map(() => 1 / kids.length)): LayoutNode => ({ t: "split", id: "s-r", dir: "row", kids, sizes });

/** Puts a layout in the mock as one commit (one space, "sp-main"). */
export async function seedLayout(root: LayoutNode | null, focus = ""): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

/** The mock's layout now (internal/layout's JSON). */
export async function layoutState(): Promise<{ spaces: { id: string; focus?: string; root: LayoutNode | null }[]; current_space: string }> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { id: string; focus?: string; root: LayoutNode | null }[]; current_space: string } }).state;
}

/** The app, once the shell has drawn its first frame (the layout and the first-load import). */
export async function openShellApp(page: Page): Promise<void> {
  await page.goto(appPath);
  await expect(page.locator('[data-testid="shell"][data-shell-mode="shell"]')).toBeVisible();
}

export const paneOf = (page: Page, id: string): Locator => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
/** The focused pane. */
export const focusedPane = (page: Page): Locator => page.locator('[data-testid="shell-pane"][data-focused]');
/** A pane's tab by kind (and the first one when several). */
export const tabOfKind = (page: Page, kind: string): Locator => page.locator(`[data-testid="shell-tab"][data-kind="${kind}"]`);
/** The pane holding the active tab of a kind: where that surface's body is. */
export const paneShowing = (page: Page, kind: string): Locator => page.locator('[data-testid="shell-pane"]').filter({ has: page.locator(`[data-testid="shell-tab"][data-kind="${kind}"][data-active]`) });

/**
 * Opens a thread's tab from its sidebar row (thread.open: the focused pane, or where it is open),
 * with the keyboard in its prompt once it draws.
 */
export async function openThread(page: Page, id: string): Promise<void> {
  await page.locator(`[data-row-key="s:${id}"]`).click();
  await expect(page.locator(`[data-testid="thread-pane"][data-thread-id="${id}"]`)).toBeVisible();
}

/** Runs a palette command by its name (the palette opened with cmd+k, filtered, the row clicked). */
export async function paletteRun(page: Page, title: string, command: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  await page.keyboard.type(title);
  await page.getByTestId("palette").locator(`[data-command="${command}"]`).click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
}

/** A page's tab from the focused pane's "+" menu (Pull Requests or Projects): one per space, focused. */
export async function openPageTab(page: Page, item: "prs" | "projects"): Promise<void> {
  await focusedPane(page).getByTestId("pane-plus").click();
  await page.getByTestId("pane-plus-menu").locator(`[data-item="${item}"]`).click();
  await expect(page.getByTestId(item === "prs" ? "prs-page" : "projects-page")).toBeVisible();
}

/** The Projects index in a tab (opened from "+" if none is open). */
export async function openProjectsIndex(page: Page): Promise<void> {
  if ((await page.getByTestId("projects-page").count()) === 0) await openPageTab(page, "projects");
  if ((await page.getByTestId("projects-page").getAttribute("data-page")) !== "index") {
    await page.evaluate(`__cfModule("/src/stores/ui.ts").then((m) => m.useUiStore.getState().select(m.PROJECTS_INDEX))`);
  }
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
}

/** Opens a surface linked to the selected thread through the app's own store (as a card row or link does). */
export async function openThreadSurface(page: Page, expr: string): Promise<void> {
  await page.evaluate(expr);
}
