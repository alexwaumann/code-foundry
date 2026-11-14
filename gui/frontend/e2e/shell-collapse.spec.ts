import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, invocations, mockUrl, resetMock } from "./fixtures";

/**
 * Collapsing a pane on demand and dividers that say they stopped (docs/notes/shell-model.md,
 * "Collapsing a pane" and "Dividers"; docs/notes/shell-25d-collapse.md), what only a browser shows:
 * the chord through the keymap, the rail's and the strip's geometry in a row and a column, the
 * direction keys passing over a collapsed pane, a drop on one, and the divider's computed cursor
 * under a real pointer. Which verb a control runs, the tooltips and the cursor rule's table are
 * vitest's (components/shell/PaneGrid.collapse.test.tsx, shell/collapse.test.ts, shell/resize.test.ts).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string; collapsed?: boolean } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const projects: Tab = { id: "t-projects", kind: "projects", title: "Projects" };
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });
const collapsed = (n: Node): Node => ({ ...n, collapsed: true }) as Node;

/** Pull Requests and Projects, s-1's thread, s-1's diff, in a row. */
const ROW: Node = { t: "split", id: "s-r", dir: "row", kids: [pane("p-l", [prs, projects]), pane("p-m", [thread("s-1")]), pane("p-r", [diff("s-1")])], sizes: [0.3, 0.4, 0.3] };

/** s-1's thread beside a column of Pull Requests over s-1's diff. */
const COL: Node = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [pane("p-m", [thread("s-1")]), { t: "split", id: "s-c", dir: "col", kids: [pane("p-a", [prs, projects]), pane("p-b", [diff("s-1")])], sizes: [0.5, 0.5] }],
  sizes: [0.5, 0.5],
};

async function seed(root: Node, focus: string, mru: string[] = []): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function stored(): Promise<{ root: Node | null; focus: string }> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  const sp = ((await res.json()) as { state: { spaces: { root: Node | null; focus: string }[] } }).state.spaces[0];
  return { root: sp?.root ?? null, focus: sp?.focus ?? "" };
}

/** The stored panes that are collapsed. */
async function storedCollapsed(): Promise<string[]> {
  const out: string[] = [];
  const walk = (n: Node | null) => {
    if (!n) return;
    if (n.t === "pane") {
      if (n.collapsed) out.push(n.id);
    } else n.kids.forEach(walk);
  };
  walk((await stored()).root);
  return out.sort();
}

const railEl = (page: Page, id: string) => page.locator(`[data-testid="shell-rail"][data-pane-id="${id}"]`);
const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);

async function box(page: Page, sel: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}

async function openShell(page: Page, width = 1500, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

/** The computed cursor under a point, as WebKit hit-tests it. */
async function cursorAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px ?? 0, py ?? 0);
    return el ? getComputedStyle(el).cursor : "";
  }, [x, y]);
}

test.beforeEach(async () => {
  await resetMock();
});

test("cmd+shift+m collapses the focused pane to a rail, its neighbours take its room by their proportions, and it opens again", async ({ page }) => {
  await seed(ROW, "p-l", ["t-prs", "t-s-1", "t-diff-s-1"]);
  await openShell(page);
  await expect(paneEl(page, "p-l")).toHaveAttribute("data-focused", "true");
  const before = { m: await box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]'), r: await box(page, '[data-testid="shell-pane"][data-pane-id="p-r"]') };
  const grid = await box(page, '[data-testid="shell-grid"]');

  await page.keyboard.press("Meta+Shift+m");
  await expect(railEl(page, "p-l")).toHaveAttribute("data-collapsed", "true");
  await expect.poll(storedCollapsed).toEqual(["p-l"]);
  // The focus went to the most recently focused open pane, and the keyboard with it.
  await expect(paneEl(page, "p-m")).toHaveAttribute("data-focused", "true");
  const rail = await box(page, '[data-testid="shell-rail"][data-pane-id="p-l"]');
  expect([rail.w, rail.h]).toEqual([36, grid.h]);
  // What the rail frees is shared 4 : 3, the stored sizes untouched.
  const m = await box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]');
  const r = await box(page, '[data-testid="shell-pane"][data-pane-id="p-r"]');
  expect(Math.abs(m.w + r.w - (grid.w - 36 - 24))).toBeLessThanOrEqual(1);
  expect(Math.abs(m.w / r.w - 4 / 3)).toBeLessThan(0.01);
  expect((await stored()).root).toMatchObject({ sizes: [0.3, 0.4, 0.3] });

  // A direction key reaches it and leaves it collapsed: its border is the focused one, the keyboard on its selected icon.
  await page.keyboard.press("Control+Meta+h");
  await expect(railEl(page, "p-l")).toHaveAttribute("data-focused", "true");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-tab-id"))).toBe("t-prs");
  expect(await storedCollapsed()).toEqual(["p-l"]);

  // cmd+shift+m with the focus on it opens it: every pane back at its old size.
  await page.keyboard.press("Meta+Shift+m");
  await expect(paneEl(page, "p-l")).toHaveAttribute("data-focused", "true");
  await expect.poll(storedCollapsed).toEqual([]);
  await expect.poll(() => box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]')).toEqual(before.m);
  expect(await box(page, '[data-testid="shell-pane"][data-pane-id="p-r"]')).toEqual(before.r);
});

test("in a column the strip's button collapses a pane to a strip, the column keeps its width, and the strip's open control opens it", async ({ page }) => {
  await seed(COL, "p-m", ["t-s-1", "t-prs"]);
  await openShell(page);
  const col = await box(page, '[data-testid="shell-pane"][data-pane-id="p-b"]');
  await paneEl(page, "p-a").getByTestId("shell-collapse").click();
  const strip = railEl(page, "p-a");
  await expect(strip).toHaveAttribute("data-orientation", "horizontal");
  const s = await box(page, '[data-testid="shell-rail"][data-pane-id="p-a"]');
  expect([s.w, s.h]).toEqual([col.w, 36]);
  // The diff below takes the height; the column is as wide as before (its diff is open).
  const b = await box(page, '[data-testid="shell-pane"][data-pane-id="p-b"]');
  expect([b.x, b.w, b.y]).toEqual([col.x, col.w, s.y + 36 + 12]);
  await strip.getByTestId("shell-rail-expand").click();
  await expect(paneEl(page, "p-a")).toHaveAttribute("data-focused", "true");
  await expect.poll(storedCollapsed).toEqual([]);
});

test("the last open pane cannot be collapsed: the button is disabled and the chord changes nothing", async ({ page }) => {
  await seed({ ...ROW, kids: [collapsed(pane("p-l", [prs, projects])), pane("p-m", [thread("s-1")]), collapsed(pane("p-r", [diff("s-1")]))] }, "p-m");
  await openShell(page);
  await expect(paneEl(page, "p-m").getByTestId("shell-collapse")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Meta+Shift+m");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pane.collapse").length).toBe(1);
  expect(await storedCollapsed()).toEqual(["p-l", "p-r"]);
  await expect(paneEl(page, "p-m")).toBeVisible();
});

test("a tab dropped on a collapsed pane opens it, and the highlight is where it lands", async ({ page }) => {
  await seed({ ...ROW, kids: [collapsed(pane("p-l", [prs, projects])), pane("p-m", [thread("s-1"), thread("s-3")]), pane("p-r", [diff("s-1")])] }, "p-m");
  await openShell(page);
  const from = await page.locator('[data-testid="shell-tab"][data-tab-id="t-s-3"]').boundingBox();
  const to = await railEl(page, "p-l").boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.waitForFunction(() => document.querySelector('[data-testid="shell-drop-preview"]')?.getAnimations().length === 0);
  const preview = await page.getByTestId("shell-drop-preview").boundingBox();
  if (!preview) throw new Error("no preview");
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
  await expect.poll(storedCollapsed).toEqual([]);
  const landed = paneEl(page, "p-l");
  await expect(landed).toHaveAttribute("data-focused", "true");
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  const b = await landed.boundingBox();
  expect([b?.x, b?.y, b?.width, b?.height].map((v) => Math.round(v ?? -1))).toEqual([preview.x, preview.y, preview.width, preview.height].map(Math.round));
});

test("a divider's cursor says which ways it can move, it stops at the minimum, and beside a collapsed pane it cannot move", async ({ page }) => {
  // The thread's pane held at its 360px minimum (its share is a tenth), a diff beside it.
  const two: Node = { t: "split", id: "s-r", dir: "row", kids: [pane("p-m", [thread("s-1")]), pane("p-r", [diff("s-1")])], sizes: [0.1, 0.9] };
  await seed(two, "p-m");
  await openShell(page);
  const gutter = page.locator('[data-testid="shell-gutter"][data-split="s-r"]');
  const g = await gutter.boundingBox();
  if (!g) throw new Error("no gutter");
  const at = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  const thread0 = await box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]');
  expect(thread0.w).toBe(360);
  // Only the diff side can give: it moves right only.
  await page.mouse.move(at.x, at.y);
  expect(await cursorAt(page, at.x, at.y)).toBe("e-resize");
  // Grabbed and dragged left, nothing moves (it starts from what is drawn, and the thread is at its minimum).
  await page.mouse.down();
  await page.mouse.move(at.x - 1, at.y);
  await page.mouse.move(at.x - 80, at.y, { steps: 4 });
  expect((await box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]')).w).toBe(360);
  expect(await cursorAt(page, at.x - 80, at.y)).toBe("e-resize");
  // Right: it moves, both ways now.
  await page.mouse.move(at.x + 100, at.y, { steps: 4 });
  await expect.poll(async () => (await box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]')).w).toBe(460);
  expect(await cursorAt(page, at.x + 100, at.y)).toBe("col-resize");
  await page.mouse.up();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pane.resize").length).toBe(1);
  await expect.poll(async () => (await box(page, '[data-testid="shell-pane"][data-pane-id="p-m"]')).w).toBe(460);
  const g2 = await gutter.boundingBox();
  if (!g2) throw new Error("no gutter");
  expect(await cursorAt(page, g2.x + g2.width / 2, g2.y + g2.height / 2)).toBe("col-resize");

  // Beside a collapsed pane: not-allowed, and a drag changes nothing.
  await seed({ ...ROW, kids: [pane("p-l", [prs, projects]), collapsed(pane("p-m", [thread("s-1")])), pane("p-r", [diff("s-1")])] }, "p-l");
  await page.reload();
  const fixed = page.locator('[data-testid="shell-gutter-fixed"]').first();
  const f = await fixed.boundingBox();
  if (!f) throw new Error("no fixed gutter");
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  expect(await cursorAt(page, fx, fy)).toBe("not-allowed");
  const left = await box(page, '[data-testid="shell-pane"][data-pane-id="p-l"]');
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 120, fy, { steps: 4 });
  await page.mouse.up();
  expect(await box(page, '[data-testid="shell-pane"][data-pane-id="p-l"]')).toEqual(left);
  expect((await invocations()).filter((i) => i.name === "pane.resize")).toHaveLength(1);
});

/** SHOTS=<dir>: a pane collapsed in a row and in a column (before: open), the strip's button, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell collapse screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/collapse-${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed(ROW, "p-l", ["t-prs", "t-s-1"]);
    await openShell(page, 1400, 760);
    await expect(page.getByTestId("thread-pane")).toBeVisible();
    await page.mouse.move(1390, 750);
    await page.screenshot({ path: at("row-before") });
    // The strip's button and its tooltip (hovered).
    await paneEl(page, "p-l").getByTestId("shell-collapse").hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.screenshot({ path: at("strip-button"), clip: { x: 260, y: 40, width: 560, height: 120 } });
    await page.keyboard.press("Meta+Shift+m");
    await expect(railEl(page, "p-l")).toBeVisible();
    await page.mouse.move(1390, 750);
    await page.screenshot({ path: at("row-after") });
    await seed(COL, "p-m", ["t-s-1", "t-prs"]);
    await page.reload();
    await expect(page.getByTestId("thread-pane")).toBeVisible();
    await page.screenshot({ path: at("col-before") });
    await paneEl(page, "p-a").getByTestId("shell-collapse").click();
    await expect(railEl(page, "p-a")).toBeVisible();
    await page.mouse.move(1390, 750);
    await page.screenshot({ path: at("col-after") });
  });
}
