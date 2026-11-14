import { expect, type Locator, type Page } from "@playwright/test";
import { CF, mockUrl } from "./fixtures";
import { layoutState, paneNode, rowNode, seedLayout, threadTab, type LayoutNode } from "./shell";

/**
 * Helpers for the specs of surfaces that were side panel tabs (diff, file, gallery, MCP, plugin
 * surfaces, pages): reaching them as linked tabs in the window shell, sizing the pane that shows
 * them, and reading its strip. What the side panel's width was is now a pane's width.
 */

/** A thread's own Diff tab (as openCheckoutDiff with own makes it), linked to the thread. */
export const diffTab = (thread = "s-1"): Record<string, unknown> => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF, own: "1" }, title: "Diff" });

/** A thread's pane (p-1) on the left and a pane of surfaces (p-2) on the right, its share `right`. */
export async function seedBeside(thread: string, tabs: Record<string, unknown>[], right = 0.45, focus = "p-1"): Promise<void> {
  await seedLayout(rowNode([paneNode("p-1", [threadTab(thread)]), paneNode("p-2", tabs)], [1 - right, right]), focus);
}

/** The pane that holds a tab of this kind (active or not). */
export const paneWith = (page: Page, kind: string): Locator => page.locator('[data-testid="shell-pane"]').filter({ has: page.locator(`[data-testid="shell-tab"][data-kind="${kind}"]`) });

/** A pane's tabs (the tab buttons, named by their surface). */
export const stripTabs = (pane: Locator): Locator => pane.getByTestId("shell-tab-strip").getByRole("tab");

/** The active tab of a kind, anywhere. */
export const activeOfKind = (page: Page, kind: string): Locator => page.locator(`[data-testid="shell-tab"][data-kind="${kind}"][data-active]`);

/** The pane id of the element with the keyboard ("" when it is in no pane). */
export function keyboardPane(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-testid="shell-pane"]')?.dataset.paneId ?? "");
}

function paneIds(n: LayoutNode): string[] {
  return n.t === "pane" ? [n.id] : n.kids.flatMap(paneIds);
}

/** The nearest split along `dir` above the pane, and which of its kids holds it. */
function findAxis(n: LayoutNode | null, id: string, dir: "row" | "col"): { split: Extract<LayoutNode, { t: "split" }>; at: number } | null {
  if (!n || n.t === "pane") return null;
  for (const k of n.kids) {
    const deeper = findAxis(k, id, dir);
    if (deeper) return deeper;
  }
  const at = n.kids.findIndex((k) => paneIds(k).includes(id));
  return n.dir === dir && at >= 0 ? { split: n, at } : null;
}

/** A pane's drawn width (or height). */
function paneLength(page: Page, id: string, row: boolean): Promise<number> {
  return page.evaluate(
    ({ id, row }) => {
      const b = document.querySelector(`[data-testid="shell-pane"][data-pane-id="${id}"]`)?.getBoundingClientRect();
      return b ? Math.round(row ? b.width : b.height) : 0;
    },
    { id, row },
  );
}

/** A pane's minimum along an axis (docs/notes/shell-25f-sizes.md): 480 x 400, a pane of terminals only 300 x 220. */
export function paneMinimumOf(n: LayoutNode | null, id: string, row: boolean): number {
  const find = (x: LayoutNode | null): LayoutNode | null => (!x ? null : x.t === "pane" ? (x.id === id ? x : null) : x.kids.map(find).find(Boolean) ?? null);
  const p = find(n);
  const terms = p?.t === "pane" && p.tabs.length > 0 && p.tabs.every((t) => t.kind === "terminal");
  return row ? (terms ? 300 : 480) : terms ? 220 : 400;
}

/** Two frames, so a resize has been measured and drawn. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Focuses pane `id` as a press on it does: only the focused pane (and its thread's) is ever drawn
 * under its minimum, the others fold first (docs/notes/shell-model.md, "Small windows").
 */
export async function focusForNarrow(page: Page, id: string): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.focusPane(${JSON.stringify(id)}))`);
  await expect(page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`)).toHaveAttribute("data-focused", "true");
}

/** The window's size before windowFor first changed it, per page: dragGutterBeside gives it back. */
const resized = new WeakMap<Page, { width: number; height: number }>();

/** Gives the window back the size it had before windowFor changed it, if it did. */
export async function restoreWindow(page: Page): Promise<void> {
  const vp = resized.get(page);
  if (!vp) return;
  resized.delete(page);
  await page.setViewportSize(vp);
  await frames(page);
}

/**
 * Resizes the window until `len` measures `px`: proportions cannot draw a pane under its minimum,
 * nor wider than the room the other panes' minimums leave it (docs/notes/shell-25f-sizes.md); a
 * smaller window (where the others fold, or share what is left with it) or a larger one can. A
 * binary search over the window's width (`row`) or height: with the proportions as they are, the
 * pane is never smaller in a larger window, over the range searched.
 */
export async function windowFor(page: Page, len: () => Promise<number>, px: number, row: boolean): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  if (!resized.has(page)) resized.set(page, vp);
  const cur = row ? vp.width : vp.height;
  const now = await len();
  if (Math.abs(now - px) <= 1) return;
  let lo = now > px ? 200 : cur;
  let hi = now > px ? cur : cur + 3000;
  const set = async (n: number) => {
    await page.setViewportSize(row ? { width: n, height: vp.height } : { width: vp.width, height: n });
    await frames(page);
  };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    await set(mid);
    const at = await len();
    if (Math.abs(at - px) <= 0.5) return;
    if (at > px) hi = mid;
    else lo = mid;
  }
  await set(Math.abs((await len()) - px) <= 1 ? hi : lo);
}

/**
 * Sizes a pane to `px` wide (`dir` "row") or tall ("col") by giving the nearest split along that
 * axis new proportions in the mock (one commit the window draws), its other kids keeping their
 * shares of what is left: what dragging the gutter would do. A size the minimums do not allow in
 * this window resizes the window instead (windowFor), as a smaller or larger window draws it.
 */
export async function setPaneSize(page: Page, paneId: string, px: number, dir: "row" | "col" = "row"): Promise<void> {
  const state = await layoutState();
  const space = state.spaces.find((s) => s.id === state.current_space) ?? state.spaces[0];
  const found = findAxis(space?.root ?? null, paneId, dir);
  if (!found) throw new Error(`pane ${paneId} is in no ${dir} split`);
  const { split, at } = found;
  const row = dir === "row";
  // Each kid's drawn length along the split: the box around its panes.
  const lens = await page.evaluate(
    ({ groups, row }) =>
      groups.map((ids) => {
        const boxes = ids.flatMap((id) => {
          const el = document.querySelector(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
          return el ? [el.getBoundingClientRect()] : [];
        });
        if (boxes.length === 0) return 0;
        const lo = Math.min(...boxes.map((b) => (row ? b.left : b.top)));
        const hi = Math.max(...boxes.map((b) => (row ? b.right : b.bottom)));
        return hi - lo;
      }),
    { groups: split.kids.map(paneIds), row },
  );
  const free = lens.reduce((a, b) => a + b, 0);
  const own = lens[at] ?? 0;
  const rest = free - own;
  split.sizes = lens.map((l, i) => (i === at ? px / free : ((free - px) * l) / rest / free));
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
  // The window has the new proportions, and has drawn them.
  const { rev } = (await res.json()) as { rev: number };
  await expect.poll(() => page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => Number(m.useLayoutStore.getState().rev))`)).toBeGreaterThanOrEqual(rev);
  await frames(page);
  // Under the pane's minimum, proportions cannot draw it: a smaller window does.
  if (px < paneMinimumOf(space?.root ?? null, paneId, row)) {
    await focusForNarrow(page, paneId);
    await windowFor(page, () => paneLength(page, paneId, row), px, row);
  } else {
    // The others held at their minimums may leave it less room than asked: a larger window gives it.
    await windowFor(page, () => paneLength(page, paneId, row), px, row);
  }
  await expect.poll(async () => Math.abs((await paneLength(page, paneId, row)) - Math.round(px))).toBeLessThanOrEqual(1);
}

/** The pane whose body shows an element with this test id (a surface's root). */
export const paneShowingSurface = (page: Page, testId: string): Locator => page.locator('[data-testid="shell-pane"]').filter({ has: page.getByTestId(testId) });

/** Sizes the pane showing a surface (by its root's test id) to `px` wide: what the side panel's width was. */
export async function setSurfaceWidth(page: Page, testId: string, px: number): Promise<void> {
  const id = await paneShowingSurface(page, testId).getAttribute("data-pane-id");
  if (!id) throw new Error(`no pane shows ${testId}`);
  await setPaneSize(page, id, px);
}

/** Shows the pane of a surface full screen (its strip's control; what expanding the side panel was). */
export async function fullScreenSurface(page: Page, testId: string): Promise<void> {
  const pane = paneShowingSurface(page, testId);
  await pane.getByTestId("shell-fullscreen").click();
  await expect(pane).toHaveAttribute("data-fullscreen", "true");
}

/**
 * Drags the gutter between the pane left of a surface's pane and that pane by `dx` px (negative:
 * the surface's pane widens), as the side panel's edge was dragged. The pointer is real; the
 * panes keep their minimums.
 */
export async function dragGutterBeside(page: Page, testId: string, dx: number, steps = 4): Promise<void> {
  // A pane narrowed under its minimum took a smaller window (windowFor): the drag starts in the window as it was.
  await restoreWindow(page);
  const pane = await paneShowingSurface(page, testId).boundingBox();
  if (!pane) throw new Error(`no pane shows ${testId}`);
  const gutters = await page.getByTestId("shell-gutter").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  const g = gutters.find((b) => Math.abs(b.right - pane.x) <= 1 && b.top <= pane.y + 1 && b.bottom >= pane.y + pane.height - 1);
  if (!g) throw new Error(`no gutter left of ${testId}'s pane`);
  const x = g.left + g.width / 2;
  const y = g.top + g.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps });
  await page.mouse.up();
}

/**
 * Waits until the daemon's layout holds thread `id`'s own tab. A verb run in the thread right
 * after a sidebar click can otherwise reach the daemon first, and a thread whose tab is not open
 * has its surfaces opened in the focused pane (shell-model.md), not beside it.
 */
export async function threadTabOpen(id: string): Promise<void> {
  const has = (n: LayoutNode | null): boolean => !!n && (n.t === "pane" ? n.tabs.some((t) => t.kind === "thread" && t.thread === id) : n.kids.some(has));
  await expect.poll(async () => (await layoutState()).spaces.some((s) => has(s.root))).toBe(true);
}
