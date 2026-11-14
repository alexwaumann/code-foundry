import { expect, type Locator, type Page } from "@playwright/test";
import { layoutState, openShellApp, paneNode, paneOf, rowNode, seedLayout, type LayoutNode } from "./shell";
import { focusForNarrow, paneMinimumOf, windowFor } from "./shell-surfaces";

/**
 * Helpers for the Pull Requests and Projects pages and the Pull request surface in the window
 * shell: the pages are tabs (one per space), and a pull request is a tab of its own, seeded beside
 * the page in a pane sized to the width a test measures at (the classic side panel's 280, 360, 420
 * and 560px widths become a pane's).
 */

export const SLUG = "alexwaumann/code-foundry";

/** The Pull Requests page's tab. */
export const PRS_TAB: Record<string, unknown> = { id: "t-prs", kind: "prs", title: "Pull Requests" };
/** The Projects tab (the index; `params.project` or `params.workspace` for a page). */
export const PROJECTS_TAB: Record<string, unknown> = { id: "t-proj", kind: "projects", title: "Projects" };
/** A pull request's tab, linked to no thread (as one opened from the Pull Requests page), or to `thread`. */
export const prTab = (n: number, thread?: string): Record<string, unknown> => ({
  id: `t-pr-${String(n)}`,
  kind: "pullrequest",
  ...(thread ? { thread } : {}),
  params: { slug: SLUG, number: String(n) },
  title: `#${String(n)}`,
});

/** The app showing `root`, focus on pane `focus`. */
export async function openLayout(page: Page, root: LayoutNode, focus: string): Promise<void> {
  await seedLayout(root, focus);
  await openShellApp(page);
}

/** The Pull Requests page as the space's one tab, its rows drawn. */
export async function openPrsTab(page: Page): Promise<void> {
  await openLayout(page, paneNode("p-1", [PRS_TAB]), "p-1");
  await expect(page.getByTestId("prs-list").locator("[data-nav-key]").first()).toBeVisible();
}

/** The Projects tab as the space's one tab, on its index. */
export async function openProjectsTab(page: Page): Promise<void> {
  await openLayout(page, paneNode("p-1", [PROJECTS_TAB]), "p-1");
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
}

/** The pane the pull request surface sits in, beside the Pull Requests page. */
export const PR_PANE = "p-pr";

/**
 * The Pull Requests page (pane p-1) with pull request `n` in a pane to its right (PR_PANE), that
 * pane focused; `width` sizes it. The surface is drawn.
 */
export async function openPrBesidePage(page: Page, n: number, width?: number): Promise<void> {
  await openLayout(page, rowNode([paneNode("p-1", [PRS_TAB]), paneNode(PR_PANE, [prTab(n)])], [0.55, 0.45]), PR_PANE);
  await expect(page.getByTestId("pr-surface")).toHaveAttribute("data-pr", `${SLUG}#${String(n)}`);
  if (width !== undefined) await sizePane(page, PR_PANE, width);
}

/**
 * Thread `thread` (pane p-1) with pull request `n` as its linked tab in a pane to its right
 * (PR_PANE), that pane focused; `width` sizes it.
 */
export async function openPrBesideThread(page: Page, thread: string, n: number, width?: number): Promise<void> {
  await openLayout(page, rowNode([paneNode("p-1", [{ id: `t-${thread}`, kind: "thread", thread }]), paneNode(PR_PANE, [prTab(n, thread)])], [0.55, 0.45]), PR_PANE);
  await expect(page.getByTestId("pr-surface")).toHaveAttribute("data-pr", `${SLUG}#${String(n)}`);
  if (width !== undefined) await sizePane(page, PR_PANE, width);
}

/**
 * Pull request `n` shown in pane `paneId`: opened there through the app's own store (a new tab, or
 * the open one), then its tab focused as a click on it does (in the focused pane a tab opened
 * without the focus waits behind the active one).
 */
export async function showPr(page: Page, n: number, paneId = PR_PANE): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(n)} }, "pane:${paneId}"))`);
  const tabId = async () => {
    const root = (await layoutState()).spaces[0]?.root ?? null;
    const find = (node: LayoutNode | null): string => {
      if (!node) return "";
      if (node.t === "split") return node.kids.map(find).find(Boolean) ?? "";
      if (node.id !== paneId) return "";
      const tab = node.tabs.find((t) => t.kind === "pullrequest" && (t.params as Record<string, string> | undefined)?.number === String(n));
      return tab ? String(tab.id) : "";
    };
    return find(root);
  };
  await expect.poll(tabId).not.toBe("");
  await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.applyLayout({ op: "focus_tab", tab: ${JSON.stringify(await tabId())} }))`);
  await expect(paneOf(page, paneId).getByTestId("pr-surface")).toHaveAttribute("data-pr", `${SLUG}#${String(n)}`);
}

/** The split above a pane (in the seeded layouts: the root row) and the pane's index in it. */
function splitOf(root: LayoutNode | null, paneId: string): { id: string; index: number; sizes: number[] } | null {
  if (!root || root.t === "pane") return null;
  const i = root.kids.findIndex((k) => k.t === "pane" && k.id === paneId);
  if (i >= 0) return { id: root.id, index: i, sizes: root.sizes };
  for (const k of root.kids) {
    const s = splitOf(k, paneId);
    if (s) return s;
  }
  return null;
}

/**
 * Sizes a pane of a two-pane row split to `width` px through the layout's set_sizes (what a
 * gutter drag sends), correcting by what it measures until the pane is that wide. A width under
 * the pane's minimum narrows the window instead (windowFor).
 */
export async function sizePane(page: Page, paneId: string, width: number): Promise<void> {
  const pane = paneOf(page, paneId);
  const measure = async () => Math.round((await pane.boundingBox())?.width ?? 0);
  // Under the pane's minimum, proportions cannot draw it: a smaller window does (docs/notes/shell-25f-sizes.md).
  if (width < paneMinimumOf((await layoutState()).spaces[0]?.root ?? null, paneId, true)) {
    await focusForNarrow(page, paneId);
    await windowFor(page, measure, width, true);
    await expect.poll(measure).toBe(width);
    return;
  }
  const rev = async (): Promise<number> => Number(await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.useLayoutStore.getState().rev)`));
  for (let i = 0; i < 4; i++) {
    const now = await measure();
    if (Math.abs(now - width) <= 0.5) break;
    const split = splitOf(((await layoutState()).spaces[0]?.root ?? null), paneId);
    if (!split || split.sizes.length !== 2) throw new Error(`pane ${paneId} is not in a two-pane split`);
    const grid = (await page.getByTestId("shell-grid").boundingBox())?.width ?? 0;
    const f = Math.min(0.95, Math.max(0.05, (split.sizes[split.index] ?? 0.5) + (width - now) / (grid - 12)));
    const sizes = split.index === 0 ? [f, 1 - f] : [1 - f, f];
    const before = await rev();
    await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.applyLayout({ op: "set_sizes", split: ${JSON.stringify(split.id)}, sizes: ${JSON.stringify(sizes)} }))`);
    await expect.poll(rev).toBeGreaterThan(before);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // The other pane held at its 480px minimum: no proportion gives this one more room; a wider window does.
    if ((await measure()) === now) {
      await windowFor(page, measure, width, true);
      break;
    }
  }
  await expect.poll(measure).toBe(width);
}

/** A pane's tab by id. */
export const tabIn = (page: Page, paneId: string, tabId: string): Locator => paneOf(page, paneId).locator(`[data-testid="shell-tab"][data-tab-id="${tabId}"]`);
