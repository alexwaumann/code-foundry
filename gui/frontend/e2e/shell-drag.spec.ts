import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, invocations, mockUrl, resetMock } from "./fixtures";

/**
 * Dragging tabs and panes in the window shell (docs/notes/shell-14-drag.md), against the mock's
 * layout seeded per test. What only a browser shows: the pointer drag itself, the preview and the
 * insertion bar as it goes, the drop landing as one `tab.move` or `pane.move`, Escape, a drag over
 * an iframe and over a terminal's xterm, a tab with a context menu (a terminal's) and the press
 * that must not drag it, and the panes tiling the grid with no gap after every drop. Which zone a
 * point is in and what a drop sends are vitest's (src/shell/drag). Set SHOTS=<dir> for the PR's
 * screenshots (WebKit, 1400x900, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const html: Tab = { id: "t-html", kind: "file", params: { project: "repo-cf", base: CF, path: "docs/preview.html" }, title: "preview.html" };
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });

// Two threads on the left; a diff over the Pull Requests page on the right.
const THREE: Node = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [pane("p-1", [thread("s-1"), thread("s-3")]), { t: "split", id: "s-c", dir: "col", kids: [pane("p-2", [diff("s-1")]), pane("p-3", [prs])], sizes: [0.5, 0.5] }],
  sizes: [0.55, 0.45],
};

async function seed(root: Node | null, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function storedRoot(): Promise<Node | null> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { root: Node | null }[] } }).state.spaces[0]?.root ?? null;
}

/** The sizes of the stored root split ([] for a pane or none). */
async function rootSizes(): Promise<number[]> {
  const root = await storedRoot();
  return root?.t === "split" ? root.sizes : [];
}

/** The stored tree as text: `row(p-1[t-s-1,t-s-3] col(...))`, ids of new panes and splits left out. */
function outline(n: Node | null): string {
  if (!n) return "";
  if (n.t === "pane") return `[${n.tabs.map((t) => t.id).join(",")}]`;
  return `${n.dir}(${n.kids.map(outline).join(" ")})`;
}

async function expectStored(want: string): Promise<void> {
  await expect.poll(async () => outline(await storedRoot())).toBe(want);
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
const tabEl = (page: Page, id: string) => page.locator(`[data-testid="shell-tab"][data-tab-id="${id}"]`);
const preview = (page: Page) => page.getByTestId("shell-drop-preview");

type Box = { x: number; y: number; w: number; h: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

const paneBox = (page: Page, id: string) => boxOf(page, `[data-testid="shell-pane"][data-pane-id="${id}"]`);
const tabBox = (page: Page, id: string) => boxOf(page, `[data-testid="shell-tab"][data-tab-id="${id}"]`);
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The empty part of a pane's strip, where the whole pane drags from: between the "+" after the last tab (not a grip) and the strip's end. */
async function stripGrip(page: Page, id: string): Promise<{ x: number; y: number }> {
  const s = await boxOf(page, `[data-testid="shell-pane"][data-pane-id="${id}"] [data-testid="shell-tab-strip"]`);
  const plus = await boxOf(page, `[data-testid="shell-pane"][data-pane-id="${id}"] [data-testid="pane-plus"]`);
  return { x: (plus.x + plus.w + s.x + s.w) / 2, y: s.y + s.h / 2 };
}

/** Presses at `from` and moves to `to` in steps, holding the button (call `drop` or press Escape after). */
async function lift(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  // Wait out the grid's settling (a previous drop's redraw); a looping spinner never ends.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

async function drop(page: Page): Promise<void> {
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
}

/** Every drawn pane inside the grid, none overlapping, and together with 12px gutters filling it. */
async function expectTiled(page: Page): Promise<void> {
  const ids = await page.getByTestId("shell-pane").evaluateAll((els) => els.map((e) => e.getAttribute("data-pane-id") ?? ""));
  const grid = await boxOf(page, '[data-testid="shell-grid"]');
  const boxes = await Promise.all(ids.map((id) => paneBox(page, id)));
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(grid.x - 0.5);
    expect(b.y).toBeGreaterThanOrEqual(grid.y - 0.5);
    expect(b.x + b.w).toBeLessThanOrEqual(grid.x + grid.w + 0.5);
    expect(b.y + b.h).toBeLessThanOrEqual(grid.y + grid.h + 0.5);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
      expect(overlap, `${String(ids[i])} overlaps ${String(ids[j])}`).toBe(false);
    }
  }
  const area = boxes.reduce((s, b) => s + b.w * b.h, 0);
  expect(area).toBeGreaterThan(grid.w * grid.h - 13 * (grid.w + grid.h) * Math.max(0, ids.length - 1));
}

/** The drop's preview now, to compare with where the pane lands. */
async function previewBox(page: Page): Promise<Box> {
  // It glides between targets for 75ms.
  await page.waitForFunction(() => document.querySelector('[data-testid="shell-drop-preview"]')?.getAnimations().length === 0);
  return boxOf(page, '[data-testid="shell-drop-preview"]');
}

function expectSameBox(a: Box, b: Box): void {
  for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(a[k] - b[k]), `${k}: ${String(a[k])} vs ${String(b[k])}`).toBeLessThanOrEqual(2);
}

const moves = async () => (await invocations()).filter((i) => i.name === "tab.move" || i.name === "pane.move");

test.beforeEach(async () => {
  await resetMock();
});

test("a tab reorders in its own strip, with the insertion bar where it will go", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  await expect(tabEl(page, "t-s-3")).toBeVisible();
  const after = await tabBox(page, "t-s-3");
  await lift(page, centre(await tabBox(page, "t-s-1")), { x: after.x + after.w - 4, y: after.y + after.h / 2 });
  const bar = page.getByTestId("shell-drop-bar");
  await expect(bar).toBeVisible();
  const b = await boxOf(page, '[data-testid="shell-drop-bar"]');
  expect(Math.abs(b.x - (after.x + after.w))).toBeLessThanOrEqual(3);
  // The lifted tab stays in its slot, dimmed.
  await expect(tabEl(page, "t-s-1")).toHaveAttribute("data-dragging", "true");
  await drop(page);
  await expectStored("row([t-s-3,t-s-1] col([t-diff-s-1] [t-prs]))");
  await expect(paneEl(page, "p-1").getByTestId("shell-tab").nth(1)).toHaveAttribute("data-tab-id", "t-s-1");
  await expectTiled(page);
});

test("an inactive tab drags into another pane's strip, at the place the bar shows", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  await expect(tabEl(page, "t-s-3")).not.toHaveAttribute("data-active", "true");
  const target = await tabBox(page, "t-prs");
  await lift(page, centre(await tabBox(page, "t-s-3")), { x: target.x + 6, y: target.y + target.h / 2 });
  await expect(page.getByTestId("shell-drop-bar")).toBeVisible();
  await expect(preview(page)).toHaveCount(0);
  await drop(page);
  await expectStored("row([t-s-1] col([t-diff-s-1] [t-s-3,t-prs]))");
  await expect(tabEl(page, "t-s-3")).toHaveAttribute("data-active", "true");
  expect((await moves()).map((m) => m.args)).toEqual([{ tab: "t-s-3", pane: "p-3", index: "0" }]);
  await expectTiled(page);
});

test("a tab dropped on a pane's edge splits it, into the rectangle the preview showed", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  const p1 = await paneBox(page, "p-1");
  await lift(page, centre(await tabBox(page, "t-prs")), { x: p1.x + p1.w - 30, y: p1.y + p1.h / 2 });
  await expect(preview(page)).toHaveAttribute("data-kind", "edge");
  await expect(preview(page)).toContainText("New pane");
  const shown = await previewBox(page);
  await drop(page);
  // p-3 had only the Pull Requests tab: it goes, and the tab is a new pane right of p-1.
  await expectStored("row([t-s-1,t-s-3] [t-prs] [t-diff-s-1])");
  await expect(paneEl(page, "p-3")).toHaveCount(0);
  const landed = await boxOf(page, '[data-testid="shell-pane"]:has([data-tab-id="t-prs"])');
  expectSameBox(landed, shown);
  await expectTiled(page);
});

test("a whole pane drags by its strip onto another pane's edge", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  const p1 = await paneBox(page, "p-1");
  await lift(page, await stripGrip(page, "p-2"), { x: p1.x + p1.w / 2, y: p1.y + p1.h - 30 });
  await expect(preview(page)).toHaveAttribute("data-kind", "edge");
  await expect(preview(page)).toContainText("Move pane here");
  await expect(paneEl(page, "p-2")).toHaveAttribute("data-dragging", "true");
  const shown = await previewBox(page);
  await drop(page);
  await expectStored("row(col([t-s-1,t-s-3] [t-diff-s-1]) [t-prs])");
  expectSameBox(await paneBox(page, "p-2"), shown);
  expect((await moves()).map((m) => [m.name, m.args])).toEqual([["pane.move", { pane: "p-2", beside: "p-1", edge: "bottom" }]]);
  await expectTiled(page);
});

test("a whole pane dropped on another pane's strip merges into it", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  const t = await tabBox(page, "t-s-3");
  await lift(page, await stripGrip(page, "p-2"), { x: t.x + t.w + 20, y: t.y + t.h / 2 });
  await expect(page.getByTestId("shell-drop-bar")).toBeVisible();
  await drop(page);
  await expectStored("row([t-s-1,t-s-3,t-diff-s-1] [t-prs])");
  await expect(paneEl(page, "p-2")).toHaveCount(0);
  await expect(tabEl(page, "t-diff-s-1")).toHaveAttribute("data-active", "true");
  await expectTiled(page);
});

test("a tab and a pane dropped on the grid's outer edge take a full-height column and a full-width row of their kind's size", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  const grid = await boxOf(page, '[data-testid="shell-grid"]');
  // A tab onto the left edge: a full-height column there.
  await lift(page, centre(await tabBox(page, "t-s-3")), { x: grid.x + 3, y: grid.y + grid.h / 2 });
  await expect(preview(page)).toHaveAttribute("data-kind", "outer");
  await expect(preview(page)).toContainText("Full-height column");
  const column = await previewBox(page);
  expect(column.x).toBeCloseTo(grid.x, 0);
  expect(column.h).toBeCloseTo(grid.h, 0);
  await drop(page);
  await expectStored("row([t-s-3] [t-s-1] col([t-diff-s-1] [t-prs]))");
  // A thread's size: half the row.
  expect((await rootSizes())[0]).toBeCloseTo(0.5, 6);
  const landed = await boxOf(page, '[data-testid="shell-pane"]:has([data-tab-id="t-s-3"])');
  expectSameBox(landed, column);
  await expectTiled(page);

  // A pane onto the bottom edge, from just below the grid: a full-width row.
  await lift(page, await stripGrip(page, "p-2"), { x: grid.x + grid.w / 2, y: grid.y + grid.h + 6 });
  await expect(preview(page)).toHaveAttribute("data-kind", "outer");
  await expect(preview(page)).toContainText("Full-width row");
  const rowBox = await previewBox(page);
  await drop(page);
  await expectStored("col(row([t-s-3] [t-s-1] [t-prs]) [t-diff-s-1])");
  // A diff's size, not half: 0.45 of the column, under its 480px floor, which it does not take
  // here as the rest would keep less than 480px.
  expect(await rootSizes()).toEqual([expect.closeTo(0.55, 6), expect.closeTo(0.45, 6)]);
  expectSameBox(await paneBox(page, "p-2"), rowBox);
  expect((await paneBox(page, "p-2")).w).toBeCloseTo(grid.w, 0);
  await expectTiled(page);
});

test("Escape cancels a drag: nothing moves and nothing is sent", async ({ page }) => {
  await seed(THREE, "p-1");
  await openShell(page);
  const p1 = await paneBox(page, "p-1");
  await lift(page, centre(await tabBox(page, "t-diff-s-1")), { x: p1.x + 30, y: p1.y + p1.h / 2 });
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(page.getByTestId("shell-drag-ghost")).toHaveCount(0);
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
  await page.mouse.up();
  await expectStored("row([t-s-1,t-s-3] col([t-diff-s-1] [t-prs]))");
  expect(await moves()).toEqual([]);
  await expectTiled(page);
});

test("a drag over an iframe's body keeps tracking the pointer", async ({ page }) => {
  // An HTML file rendered in a sandboxed frame fills p-2.
  await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1"), thread("s-3")]), pane("p-2", [html])], sizes: [0.5, 0.5] }, "p-1");
  await openShell(page);
  const frame = page.getByTestId("file-html-frame");
  await expect(frame).toBeVisible();
  const f = await boxOf(page, '[data-testid="file-html-frame"]');
  // Into the frame's middle: the pane's middle; on to the frame's right side: that pane's right edge.
  await lift(page, centre(await tabBox(page, "t-s-3")), { x: f.x + f.w / 2, y: f.y + f.h / 2 });
  await expect(preview(page)).toHaveAttribute("data-kind", "pane");
  await page.mouse.move(f.x + f.w - 20, f.y + f.h / 2, { steps: 6 });
  await expect(preview(page)).toHaveAttribute("data-kind", "edge");
  await drop(page);
  await expectStored("row([t-s-1] [t-html] [t-s-3])");
  await expectTiled(page);
});

test("a drag over a terminal's body keeps tracking the pointer", async ({ page }) => {
  // Thread s-1's shell as a terminal tab fills p-2: an xterm canvas under the pointer.
  const term: Tab = { id: "t-term", kind: "terminal", thread: "s-1", params: { terminal: "t-s1-shell" } };
  await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1"), thread("s-3")]), pane("p-2", [term])], sizes: [0.5, 0.5] }, "p-1");
  await openShell(page);
  const host = page.getByTestId("shell-terminal-host");
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  const t = await boxOf(page, '[data-testid="shell-terminal-host"]');
  // Into the terminal's middle: the pane's middle; on to its right side: that pane's right edge.
  await lift(page, centre(await tabBox(page, "t-s-3")), { x: t.x + t.w / 2, y: t.y + t.h / 2 });
  await expect(preview(page)).toHaveAttribute("data-kind", "pane");
  await page.mouse.move(t.x + t.w - 20, t.y + t.h / 2, { steps: 6 });
  await expect(preview(page)).toHaveAttribute("data-kind", "edge");
  await drop(page);
  await expectStored("row([t-s-1] [t-term] [t-s-3])");
  await expectTiled(page);
  // The terminal neither lost its stream nor took the keyboard.
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  expect(await page.evaluate(() => document.activeElement?.closest("[data-terminal-host]") === null)).toBe(true);
});

test("a terminal tab drags like any tab; a press in its name field or its context menu does not", async ({ page }) => {
  const term: Tab = { id: "t-term", kind: "terminal", thread: "s-1", params: { terminal: "t-s1-shell" }, name: "server" };
  const top: Tab = { id: "t-top", kind: "terminal", params: { terminal: "t-top" } };
  await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1")]), pane("p-2", [term, top])], sizes: [0.5, 0.5] }, "p-1");
  await openShell(page);
  // The inactive terminal tab (inside its context menu's trigger) drags into the other strip.
  const s1 = await tabBox(page, "t-s-1");
  await lift(page, centre(await tabBox(page, "t-top")), { x: s1.x + s1.w + 30, y: s1.y + s1.h / 2 });
  await drop(page);
  await expectStored("row([t-s-1,t-top] [t-term])");
  const sent = (await moves()).length;

  // A right press, moved, opens the menu and drags nothing. It moves away from the menu (which
  // opens down and right of the press): a release on an item would pick it, as menus do.
  const t = centre(await tabBox(page, "t-term"));
  await page.mouse.move(t.x, t.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(t.x - 40, t.y + 30, { steps: 6 });
  await expect(page.getByTestId("shell-drag-ghost")).toHaveCount(0);
  await page.mouse.up({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();

  // Selecting text in the name field drags nothing either.
  const field = page.getByTestId("shell-tab-name-field");
  await expect(field).toBeFocused();
  const f = await boxOf(page, '[data-testid="shell-tab-name-field"]');
  await page.mouse.move(f.x + 4, f.y + f.h / 2);
  await page.mouse.down();
  await page.mouse.move(f.x + 60, f.y + f.h / 2 + 30, { steps: 8 });
  await expect(page.getByTestId("shell-drag-ghost")).toHaveCount(0);
  await page.mouse.up();
  await expect(field).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  expect((await moves()).length).toBe(sent);
  await expectStored("row([t-s-1,t-top] [t-term])");
});

/** SHOTS=<dir>: mid-drag over a strip (the bar), over a pane's edge and over the outer edge (a tab, then a diff pane), dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell drag screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await seed(THREE, "p-1");
    await openShell(page);
    await expect(page.getByTestId("thread-pane").first()).toBeVisible();
    const target = await tabBox(page, "t-prs");
    await lift(page, centre(await tabBox(page, "t-s-3")), { x: target.x + 4, y: target.y + target.h / 2 });
    await expect(page.getByTestId("shell-drop-bar")).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/shell-drag-strip${suffix}.png` });
    const p1 = await paneBox(page, "p-1");
    await page.mouse.move(p1.x + p1.w - 40, p1.y + p1.h / 2, { steps: 6 });
    await expect(preview(page)).toHaveAttribute("data-kind", "edge");
    await previewBox(page);
    await page.screenshot({ path: `${shots ?? ""}/shell-drag-edge${suffix}.png` });
    const grid = await boxOf(page, '[data-testid="shell-grid"]');
    await page.mouse.move(grid.x + grid.w / 2, grid.y + grid.h - 3, { steps: 6 });
    await expect(preview(page)).toHaveAttribute("data-kind", "outer");
    await previewBox(page);
    await page.screenshot({ path: `${shots ?? ""}/shell-drag-outer${suffix}.png` });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    // A diff pane over the outer bottom edge: its kind's size (0.45), not half.
    await lift(page, await stripGrip(page, "p-2"), { x: grid.x + grid.w / 2, y: grid.y + grid.h - 3 });
    await expect(preview(page)).toHaveAttribute("data-kind", "outer");
    await previewBox(page);
    await page.screenshot({ path: `${shots ?? ""}/shell-drag-outer-pane${suffix}.png` });
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });
}
