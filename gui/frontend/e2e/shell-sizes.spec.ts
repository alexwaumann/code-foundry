import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, mockUrl, resetMock } from "./fixtures";

/**
 * One pane minimum and room for panes (docs/notes/shell-model.md, "Small windows", "Room for
 * panes" and "Sidebar"; docs/notes/shell-25f-sizes.md), what only a browser shows: a real pointer
 * drag over a pane's body at the limit adds to the pane (no edge splits it), a pane of terminals
 * under a thread is no target for a thread's tab it has no room for, and the sidebar's right edge
 * lines up with the top bar's toggle. Which drops fit, the "+" menu and the fit rule are vitest's
 * (shell/drag/room.test.ts, targets.test.ts, geometry/fit.test.ts; the daemon's in Go).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light); they run on the tree before the
 * change as well, for the "before".
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string; collapsed?: boolean } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const terminal = (id: string, term: string, thread = ""): Tab => ({ id, kind: "terminal", ...(thread ? { thread } : {}), params: { terminal: term } });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const projects: Tab = { id: "t-projects", kind: "projects", title: "Projects" };
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });
const collapsed = (n: Node): Node => ({ ...n, collapsed: true }) as Node;
const split = (id: string, dir: "row" | "col", sizes: number[], ...kids: Node[]): Node => ({ t: "split", id, dir, sizes, kids });

const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);

async function seed(root: Node, focus: string, mru: string[] = []): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function stored(): Promise<Node | null> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { root: Node | null }[] } }).state.spaces[0]?.root ?? null;
}

/** The stored panes, each as its tab ids. */
async function storedPanes(): Promise<string[][]> {
  const out: string[][] = [];
  const walk = (n: Node | null) => {
    if (!n) return;
    if (n.t === "pane") out.push(n.tabs.map((t) => t.id));
    else n.kids.forEach(walk);
  };
  walk(await stored());
  return out;
}

async function openShell(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

/** Finite animations done (a spinner runs for ever). */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
}

/** Picks up tab `tab` by a real pointer and moves over `to`; the caller drops or cancels. */
async function dragTabOver(page: Page, tab: string, to: { x: number; y: number }): Promise<void> {
  const from = await page.locator(`[data-testid="shell-tab"][data-tab-id="${tab}"]`).boundingBox();
  if (!from) throw new Error(`no tab ${tab}`);
  await settled(page);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

/** The highlight's box, once its glide has ended; null when there is none. */
async function previewBox(page: Page): Promise<{ x: number; y: number; w: number; h: number } | null> {
  if ((await page.getByTestId("shell-drop-preview").count()) === 0) return null;
  await page.waitForFunction(() => document.querySelector('[data-testid="shell-drop-preview"]')?.getAnimations().length === 0);
  const b = await page.getByTestId("shell-drop-preview").boundingBox();
  return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
}

async function boxOf(page: Page, id: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await paneEl(page, id).boundingBox();
  if (!b) throw new Error(`no pane ${id}`);
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}

/** s-1 and s-3 in one pane beside s-1's diff: two panes, as many as a 1440-wide window fits in a row. */
const LIMIT = split("s-r", "row", [0.5, 0.5], pane("p-a", [thread("s-1"), thread("s-3")]), pane("p-b", [diff("s-1")]));

/** s-1's thread over a pane holding only its terminal: 400 + 12 + 220 tall. */
const TERMS = split("s-r", "col", [0.7, 0.3], pane("p-a", [thread("s-1"), thread("s-3"), terminal("t-sh2", "t-top")]), pane("p-t", [terminal("t-sh", "t-s1-shell", "s-1")]));

test.beforeEach(async () => {
  await resetMock();
});

test("at the limit, a tab dragged over a pane's body adds to the pane wherever it is: no edge splits it", async ({ page }) => {
  await seed(LIMIT, "p-a", ["t-s-1"]);
  // 1440 x 800: the grid is 1176 x 732, two panes in a row and neither a third column nor a second row fit.
  await openShell(page, 1440, 800);
  const b = await boxOf(page, "p-b");
  // Near its right edge, where a split's zone would be.
  await dragTabOver(page, "t-s-3", { x: b.x + b.w - 30, y: b.y + b.h / 2 });
  expect(await previewBox(page)).toEqual(b);
  await expect(page.getByTestId("shell-drop-preview")).toContainText("Add to this pane");
  // Near its bottom edge too.
  await page.mouse.move(b.x + b.w / 2, b.y + b.h - 20, { steps: 4 });
  expect(await previewBox(page)).toEqual(b);
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
  await expect.poll(storedPanes).toEqual([["t-s-1"], ["t-diff-s-1", "t-s-3"]]);
});

test("a split is offered on the edges that fit: below the pane in a taller window, not beside it", async ({ page }) => {
  await seed(LIMIT, "p-a", ["t-s-1"]);
  // 1440 x 900: the grid is 832 tall, room for a row of 400 under one of 400; a third column still does not fit.
  await openShell(page, 1440, 900);
  const b = await boxOf(page, "p-b");
  await dragTabOver(page, "t-s-3", { x: b.x + b.w - 30, y: b.y + b.h / 2 });
  expect(await previewBox(page)).toEqual(b);
  await page.mouse.move(b.x + b.w / 2, b.y + b.h - 20, { steps: 4 });
  const below = await previewBox(page);
  expect(below?.x).toBe(b.x);
  expect(below?.w).toBe(b.w);
  expect(below?.h).toBeLessThan(b.h);
  await page.mouse.up();
  await expect.poll(storedPanes).toEqual([["t-s-1"], ["t-diff-s-1"], ["t-s-3"]]);
});

test("a pane of terminals under a thread is no target for a thread's tab it has no room for; a terminal joins it", async ({ page }) => {
  await seed(TERMS, "p-a", ["t-s-1"]);
  // 1440 x 700: the grid is 632 tall, the thread's 400 and the terminals' 220 exactly.
  await openShell(page, 1440, 700);
  const t = await boxOf(page, "p-t");
  await expect(paneEl(page, "p-t")).toBeVisible();
  // s-3's tab over the terminals' middle and over their strip: no highlight, and a drop puts it back.
  await dragTabOver(page, "t-s-3", { x: t.x + t.w / 2, y: t.y + t.h / 2 + 20 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveCount(0);
  await page.mouse.move(t.x + t.w - 60, t.y + 20, { steps: 4 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveCount(0);
  await expect(page.getByTestId("shell-drop-bar")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
  expect(await storedPanes()).toEqual([["t-s-1", "t-s-3", "t-sh2"], ["t-sh"]]);
  // A terminal's tab joins it as usual.
  await dragTabOver(page, "t-sh2", { x: t.x + t.w / 2, y: t.y + t.h / 2 + 20 });
  expect(await previewBox(page)).toEqual(t);
  await page.mouse.up();
  await expect.poll(storedPanes).toEqual([["t-s-1", "t-s-3"], ["t-sh", "t-sh2"]]);
});

test("the sidebar at its minimum lines its right edge up with the top bar's toggle, at 100% and zoomed", async ({ page }) => {
  await seed(LIMIT, "p-a", ["t-s-1"]);
  await openShell(page, 1440, 900);
  const edges = async () => {
    const s = await page.getByTestId("sidebar").boundingBox();
    const t = await page.getByTestId("top-bar-sidebar-toggle").boundingBox();
    return [Math.round((s?.x ?? 0) + (s?.width ?? 0)), Math.round((t?.x ?? 0) + (t?.width ?? 0))];
  };
  expect(await edges()).toEqual([240, 240]);
  // Zoomed out (cmd+-): the lights' gutter keeps 80 screen px, the rest shrinks; the sidebar follows.
  await page.keyboard.press("Meta+Minus");
  await expect.poll(async () => { const [s, t] = await edges(); return Math.abs((s ?? 0) - (t ?? 0)); }).toBeLessThanOrEqual(1);
  expect((await edges())[0]).toBeLessThan(240);
});

/** SHOTS=<dir>: the scenes of docs/notes/shell-25f-sizes.md, dark and light; the same scenes on the tree before it. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell sizes screenshots (${scheme})`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/sizes-${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });

    // 1440 x 900: two panes open in the row, and Pull Requests collapsed beside them.
    await seed(split("s-r", "row", [0.4, 0.2, 0.4], pane("p-a", [thread("s-1"), thread("s-3")]), collapsed(pane("p-c", [prs, projects])), pane("p-b", [diff("s-1")])), "p-a", ["t-s-1"]);
    await openShell(page, 1440, 900);
    await settled(page);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: at("1-window") });

    // A drag over the diff's pane at the limit, near its right edge: the highlight is the whole pane.
    await seed(LIMIT, "p-a", ["t-s-1"]);
    await openShell(page, 1440, 800);
    const b = await boxOf(page, "p-b");
    await dragTabOver(page, "t-s-3", { x: b.x + b.w - 30, y: b.y + b.h / 2 });
    await previewBox(page);
    await page.screenshot({ path: at("2-drag-at-limit") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);

    // A terminal strip under a thread, a thread's tab dragged over it.
    await seed(TERMS, "p-a", ["t-s-1"]);
    await openShell(page, 1440, 700);
    const t = await boxOf(page, "p-t");
    await dragTabOver(page, "t-s-3", { x: t.x + t.w / 2, y: t.y + t.h / 2 + 20 });
    // Before this change the strip took the tab (a highlight); now it shows none.
    await previewBox(page);
    await page.screenshot({ path: at("3-terminal-strip") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);

    // The sidebar at its minimum beside the top bar.
    await page.mouse.move(700, 400);
    await page.screenshot({ path: at("4-sidebar"), clip: { x: 0, y: 0, width: 520, height: 420 } });
  });
}
