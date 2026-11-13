import { expect, test, type Page } from "@playwright/test";
import { appPath, invocations, mockPost, mockUrl, openStreams, resetMock } from "./fixtures";

/**
 * The window shell's pane grid behind the shell flag (docs/notes/shell-11-pane-grid.md), against
 * the mock's layout seeded per test. What only a browser shows: the gutter's drag and the tiling it
 * keeps, focus moving between panes by a press and by ctrl+cmd+h/j/k/l through the keymap, and the
 * WatchThread streams of visible and hidden thread tabs. Which body mounts, the strip's fitting, the
 * selection bridge and the key table are vitest's (components/shell, stores/selectionBridge,
 * the commands' keybindings). Set SHOTS=<dir> for the PR's screenshots (WebKit, 1400x900, dark and light).
 */

type Node = { t: "pane"; id: string; tabs: Record<string, unknown>[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string) => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string, worktree: string) => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree }, title: "Diff" });
const pane = (id: string, tabs: Record<string, unknown>[], active = String(tabs[0]?.id)): Node => ({ t: "pane", id, tabs, active });

/** Puts a layout (internal/layout's JSON) in the mock as one commit. */
async function seed(root: Node | null, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function stored(): Promise<{ spaces: { focus: string; root: Node | null }[] }> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { focus: string; root: Node | null }[] } }).state;
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);

async function box(page: Page, id: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await paneEl(page, id).boundingBox();
  if (!b) throw new Error(`pane ${id} has no box`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** The panes' boxes tile the grid: inside it, no overlaps, and with 12px gutters they fill it. */
async function expectTiled(page: Page, ids: string[]): Promise<void> {
  const grid = await page.getByTestId("shell-grid").boundingBox();
  if (!grid) throw new Error("no grid");
  const boxes = await Promise.all(ids.map((id) => box(page, id)));
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(grid.x - 0.5);
    expect(b.y).toBeGreaterThanOrEqual(grid.y - 0.5);
    expect(b.x + b.w).toBeLessThanOrEqual(grid.x + grid.width + 0.5);
    expect(b.y + b.h).toBeLessThanOrEqual(grid.y + grid.height + 0.5);
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
  // What the panes leave is the gutters: less than a 13px band along every gap.
  expect(area).toBeGreaterThan(grid.width * grid.height - 13 * (grid.width + grid.height) * (ids.length - 1));
}

// A thread beside a column of its diff and the Pull Requests page.
const THREE: Node = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [
    pane("p-1", [thread("s-1"), thread("s-3")]),
    { t: "split", id: "s-c", dir: "col", kids: [pane("p-2", [diff("s-1", "/Users/dev/src/code-foundry")]), pane("p-3", [{ id: "t-prs", kind: "prs", title: "Pull Requests" }])], sizes: [0.5, 0.5] },
  ],
  sizes: [0.55, 0.45],
};

test.beforeEach(async () => {
  await resetMock();
});

test("a gutter drag resizes the panes beside it, keeps the tiling, and is stored", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(THREE, "p-1");
  await openShell(page);
  await expect(page.getByTestId("shell-pane")).toHaveCount(3);
  await expectTiled(page, ["p-1", "p-2", "p-3"]);
  const before = { left: await box(page, "p-1"), top: await box(page, "p-2") };

  const gutter = page.locator('[data-testid="shell-gutter"][data-split="s-r"]');
  const g = await gutter.boundingBox();
  if (!g) throw new Error("no gutter");
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 60, g.y + g.height / 2, { steps: 4 });
  await page.mouse.move(g.x + g.width / 2 - 120, g.y + g.height / 2, { steps: 4 });
  // The drag previews as it goes.
  await expect.poll(async () => Math.round((await box(page, "p-1")).w)).toBe(Math.round(before.left.w - 120));
  await page.mouse.up();

  await expect
    .poll(async () => {
      const root = (await stored()).spaces[0]?.root;
      return root?.t === "split" ? Number(root.sizes[0]?.toFixed(2)) : 0;
    })
    .toBeLessThan(0.55);
  // After the commit the panes stay where the drag left them.
  const after = { left: await box(page, "p-1"), top: await box(page, "p-2") };
  expect(Math.round(after.left.w)).toBe(Math.round(before.left.w - 120));
  expect(Math.round(after.top.x)).toBe(Math.round(before.top.x - 120));
  await expectTiled(page, ["p-1", "p-2", "p-3"]);

  // Down a column too.
  const row = page.locator('[data-testid="shell-gutter"][data-split="s-c"]');
  const r = await row.boundingBox();
  if (!r) throw new Error("no row gutter");
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await box(page, "p-2")).h)).toBe(Math.round(after.top.h + 80));
  await expectTiled(page, ["p-1", "p-2", "p-3"]);
});

test("focus moves between panes by a press and by ctrl+cmd+h/j/k/l, and the keyboard follows", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(THREE, "p-1");
  await openShell(page);
  const focused = page.locator('[data-testid="shell-pane"][data-focused]');
  await expect(focused).toHaveAttribute("data-pane-id", "p-1");

  // A press in the Pull Requests page.
  await paneEl(page, "p-3").getByTestId("shell-pane-body").click({ position: { x: 40, y: 200 } });
  await expect(focused).toHaveAttribute("data-pane-id", "p-3");
  await expect.poll(async () => (await stored()).spaces[0]?.focus).toBe("p-3");

  const keyIn = async () => page.evaluate(() => document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? "");
  for (const [key, want] of [
    ["k", "p-2"],
    ["h", "p-1"],
    ["l", "p-2"],
    ["j", "p-3"],
    ["ArrowLeft", "p-1"],
  ] as const) {
    await page.keyboard.press(`Control+Meta+${key}`);
    await expect(focused).toHaveAttribute("data-pane-id", want);
    await expect.poll(keyIn).toBe(want);
  }
  await expect.poll(async () => (await stored()).spaces[0]?.focus).toBe("p-1");
  // Into the thread's pane: its prompt takes the keyboard.
  await expect(paneEl(page, "p-1").getByTestId("composer-input")).toBeFocused();
  // Nothing to the left: nothing moves.
  await page.keyboard.press("Control+Meta+h");
  await expect(focused).toHaveAttribute("data-pane-id", "p-1");
});

test("two panes showing two threads hold two WatchThread streams; a hidden tab holds none", async ({ page }) => {
  await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1"), thread("s-3")]), pane("p-2", [thread("s-5")])], sizes: [0.5, 0.5] }, "p-1");
  await openShell(page);
  await expect(page.getByTestId("thread-pane")).toHaveCount(2);
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(2);
  // s-3's tab shows instead of s-1's: still two, s-1's released.
  await paneEl(page, "p-1").locator('[data-tab-id="t-s-3"] [role="tab"]').click();
  await expect(paneEl(page, "p-1").locator("[data-thread-id]")).toHaveAttribute("data-thread-id", "s-3");
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(2);
  // Closing the pane's tabs leaves one thread on screen and one stream.
  await page.keyboard.press("Control+Meta+l");
  await page.keyboard.press("Meta+Shift+w");
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
});

test("sending from a composer tab turns it into the new thread's tab, in place", async ({ page }) => {
  await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1"), { id: "t-c", kind: "compose", params: { project: "repo-cf" } }], "t-c"), pane("p-2", [thread("s-5")])], sizes: [0.5, 0.5] }, "p-1");
  await openShell(page);
  const input = paneEl(page, "p-1").getByTestId("composer-input");
  await input.click();
  await page.keyboard.type("Tidy the README");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.new")?.args.compose).toBe("t-c");
  // The thread's tab is where the composer was, active, in the focused pane.
  await expect(paneEl(page, "p-1").getByTestId("thread-pane")).toBeVisible();
  const tabs = paneEl(page, "p-1").getByTestId("shell-tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute("data-kind", "thread");
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");
  await expect(paneEl(page, "p-1")).toHaveAttribute("data-focused", "true");
});

test("a layout a newer build wrote: one quiet line under the grid, which shrinks to make room", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(THREE, "p-1");
  await openShell(page);
  const grid = page.getByTestId("shell-grid");
  const before = (await grid.boundingBox())?.height ?? 0;
  await mockPost("layout/newer?on=1");
  const line = page.getByTestId("shell-newer-layout");
  await expect(line).toBeVisible();
  // Under the grid, inside the window, one line high; the panes keep to the smaller grid.
  const g = await grid.boundingBox();
  const l = await line.boundingBox();
  expect((g?.y ?? 0) + (g?.height ?? 0)).toBeLessThanOrEqual(l?.y ?? 0);
  expect((l?.y ?? 0) + (l?.height ?? 0)).toBeLessThanOrEqual(900);
  expect(l?.height ?? 99).toBeLessThanOrEqual(24);
  expect(g?.height ?? 0).toBeLessThan(before);
  const bottoms = await page.locator('[data-testid="shell-pane"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
  for (const b of bottoms) expect(b).toBeLessThanOrEqual((g?.y ?? 0) + (g?.height ?? 0) + 0.5);
  await mockPost("layout/newer?on=0");
  await expect(line).toHaveCount(0);
});

/** SHOTS=<dir>: the grid with three panes and the empty space, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell grid screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await seed(THREE, "p-1");
    await openShell(page);
    await expect(page.getByTestId("thread-pane")).toBeVisible();
    await page.mouse.move(700, 880);
    await page.screenshot({ path: `${shots ?? ""}/shell-grid${suffix}.png` });
    await seed(null, "");
    await expect(page.getByTestId("shell-empty-space")).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/shell-empty${suffix}.png` });
    // A newer build's layout: the line under the grid.
    await seed(THREE, "p-1");
    await mockPost("layout/newer?on=1");
    await expect(page.getByTestId("shell-newer-layout")).toBeVisible();
    await page.mouse.move(700, 880);
    await page.screenshot({ path: `${shots ?? ""}/shell-newer-layout${suffix}.png` });
  });
}
