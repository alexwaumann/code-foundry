import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, invocations, mockUrl, resetMock } from "./fixtures";

/**
 * The top bar and spaces in the window shell (docs/notes/shell-15-spaces.md), against the mock's
 * layout seeded per test. What only a browser shows: a tab and a pane dragged onto a space tab by
 * the pointer, the space tab marked under it and the drop landing in that space; back and forward
 * through the focus across spaces by the keymap's chords (cmd+[, cmd+], ctrl+cmd+n); and the top
 * bar as the window's drag band that still takes clicks on its controls. Which command each
 * control runs, the counts, the glyphs and the remove dialog's outcomes are vitest's
 * (components/shell/TopBar.test.tsx, shell/spaces.test.ts, stores/focusHistory.test.ts). Set
 * SHOTS=<dir> for the PR's screenshots (WebKit, 1400x900, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };
interface SpaceState {
  id: string;
  name: string;
  root: Node | null;
  focus?: string;
  mru?: string[];
}

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const projects: Tab = { id: "t-projects", kind: "projects", title: "Projects" };
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });
const row = (id: string, kids: Node[], sizes = kids.map(() => 1 / kids.length)): Node => ({ t: "split", id, dir: "row", kids, sizes });
const col = (id: string, kids: Node[], sizes = kids.map(() => 1 / kids.length)): Node => ({ t: "split", id, dir: "col", kids, sizes });

/** Main: two threads, s-1's diff, and the Pull Requests page; Release: Projects, s-2 lives there; Reviews: empty. */
const MAIN: SpaceState = {
  id: "sp-main",
  name: "Shell redesign",
  root: row("s-r", [pane("p-1", [thread("s-1"), thread("s-3")]), col("s-c", [pane("p-2", [diff("s-1")]), pane("p-3", [prs])])], [0.55, 0.45]),
  focus: "p-1",
};
const RELEASE: SpaceState = { id: "sp-rel", name: "Release 0.22", root: row("s-r2", [pane("p-8", [thread("s-2")]), pane("p-9", [projects])]), focus: "p-8" };
const REVIEWS: SpaceState = { id: "sp-rev", name: "Reviews", root: null };

async function seed(spaces: SpaceState[], current = spaces[0]?.id ?? "", threads: Record<string, { space: string }> = { "s-2": { space: "sp-rel" } }): Promise<void> {
  const state = { v: 1, spaces: spaces.map((s) => ({ mru: [], ...s })), current_space: current, default_space: spaces[0]?.id ?? "", threads };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

interface Stored {
  current_space: string;
  spaces: { id: string; root: Node | null; focus?: string }[];
  threads?: Record<string, { space: string }>;
}

async function stored(): Promise<Stored> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: Stored }).state;
}

function tabIds(n: Node | null): string[] {
  if (!n) return [];
  return n.t === "pane" ? n.tabs.map((t) => t.id) : n.kids.flatMap(tabIds);
}

async function tabsIn(space: string): Promise<string[]> {
  return tabIds((await stored()).spaces.find((s) => s.id === space)?.root ?? null).sort();
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await expect(page.getByTestId("space-tab")).not.toHaveCount(0);
}

const spaceTab = (page: Page, id: string) => page.locator(`[data-testid="space-tab"][data-space-id="${id}"]`);
const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
const tabEl = (page: Page, id: string) => page.locator(`[data-testid="shell-tab"][data-tab-id="${id}"]`);

type Box = { x: number; y: number; w: number; h: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The empty part of a pane's strip, where the whole pane drags from. */
async function stripGrip(page: Page, id: string): Promise<{ x: number; y: number }> {
  const s = await boxOf(page, `[data-testid="shell-pane"][data-pane-id="${id}"] [data-testid="shell-tab-strip"]`);
  const plus = await boxOf(page, `[data-testid="shell-pane"][data-pane-id="${id}"] [data-testid="pane-plus"]`);
  return { x: (plus.x + plus.w + s.x + s.w) / 2, y: s.y + s.h / 2 };
}

/** Presses at `from` and moves onto `to` in steps, holding the button. */
async function lift(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 10 });
}

async function drop(page: Page): Promise<void> {
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
}

/** The page's finite animations have finished (a menu's zoom in): a screenshot shows it whole. */
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
});

test("a tab and a pane dropped on a space tab move to that space", async ({ page }) => {
  await seed([MAIN, RELEASE, REVIEWS]);
  await openShell(page);

  // A linked tab by itself: the space tab is marked while the tab is over it, and the diff waits there.
  await lift(page, centre(await boxOf(page, '[data-testid="shell-tab"][data-tab-id="t-diff-s-1"]')), centre(await boxOf(page, '[data-testid="space-tab"][data-space-id="sp-rev"]')));
  await expect(spaceTab(page, "sp-rev")).toHaveAttribute("data-drop-target", "true");
  // Over the top bar there is no preview in the grid: the outer band above the panes stops at the bar.
  await expect(page.getByTestId("shell-drop-preview")).toHaveCount(0);
  await drop(page);
  await expect.poll(() => tabsIn("sp-rev")).toEqual(["t-diff-s-1"]);
  expect(await tabsIn("sp-main")).not.toContain("t-diff-s-1");
  // The window stays in its space; the glyph of Reviews now shows one pane.
  await expect(page.getByTestId("shell-grid")).toHaveAttribute("data-space-id", "sp-main");
  await expect(spaceTab(page, "sp-rev")).not.toHaveAttribute("data-drop-target", "true");

  // A whole pane by its strip.
  await lift(page, await stripGrip(page, "p-3"), centre(await boxOf(page, '[data-testid="space-tab"][data-space-id="sp-rel"]')));
  await expect(spaceTab(page, "sp-rel")).toHaveAttribute("data-drop-target", "true");
  await drop(page);
  await expect.poll(() => tabsIn("sp-rel")).toEqual(["t-prs", "t-projects", "t-s-2"].sort());
  await expect(paneEl(page, "p-3")).toHaveCount(0);

  // A thread's own tab moves the thread (thread.space.move).
  await lift(page, centre(await boxOf(page, '[data-testid="shell-tab"][data-tab-id="t-s-3"]')), centre(await boxOf(page, '[data-testid="space-tab"][data-space-id="sp-rev"]')));
  await drop(page);
  await expect.poll(async () => (await stored()).threads?.["s-3"]?.space).toBe("sp-rev");
  await expect.poll(() => tabsIn("sp-rev")).toEqual(["t-diff-s-1", "t-s-3"]);
  const ran = (await invocations()).map((i) => i.name).filter((n) => /^(tab|pane|thread\.space)\.move$/.test(n));
  expect(ran).toEqual(["tab.move", "pane.move", "thread.space.move"]);

  // The space a drag starts in is not a target.
  await lift(page, centre(await boxOf(page, '[data-testid="shell-tab"][data-tab-id="t-s-1"]')), centre(await boxOf(page, '[data-testid="space-tab"][data-space-id="sp-main"]')));
  await expect(spaceTab(page, "sp-main")).not.toHaveAttribute("data-drop-target", "true");
  await drop(page);
  await expect(tabEl(page, "t-s-1")).toBeVisible();
});

// A pane holding two threads' tabs goes by its strip in one command; both threads live in the
// space it lands in and s-1's diff, in another pane, goes with its thread (shell 24a, item 4).
test("a pane holding two threads dropped on a space tab moves whole in one command", async ({ page }) => {
  await seed([MAIN, REVIEWS]);
  await openShell(page);
  await lift(page, await stripGrip(page, "p-1"), centre(await boxOf(page, '[data-testid="space-tab"][data-space-id="sp-rev"]')));
  await expect(spaceTab(page, "sp-rev")).toHaveAttribute("data-drop-target", "true");
  await drop(page);
  await expect.poll(() => tabsIn("sp-rev")).toEqual(["t-diff-s-1", "t-s-1", "t-s-3"]);
  const st = await stored();
  expect([st.threads?.["s-1"]?.space, st.threads?.["s-3"]?.space]).toEqual(["sp-rev", "sp-rev"]);
  expect(await tabsIn("sp-main")).toEqual(["t-prs"]);
  const ran = (await invocations()).map((i) => i.name).filter((n) => /^(tab|pane|thread\.space)\.move$/.test(n));
  expect(ran).toEqual(["pane.move"]);
});

test("back and forward go through the focus across panes and spaces", async ({ page }) => {
  await seed([MAIN, RELEASE]);
  await openShell(page);
  const grid = page.getByTestId("shell-grid");
  await expect(paneEl(page, "p-1")).toHaveAttribute("data-focused", "true");

  // Focus the Pull Requests pane, then switch space by ctrl+cmd+2 and focus Projects there.
  await paneEl(page, "p-3").getByTestId("shell-tab-strip").click({ position: { x: 200, y: 20 } });
  await expect(paneEl(page, "p-3")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Control+Meta+2");
  await expect(grid).toHaveAttribute("data-space-id", "sp-rel");
  await tabEl(page, "t-projects").click();
  await expect(paneEl(page, "p-9")).toHaveAttribute("data-focused", "true");

  // cmd+[ : back to Release's thread pane, then across to Main's Pull Requests pane, then its first pane.
  await page.keyboard.press("Meta+BracketLeft");
  await expect(paneEl(page, "p-8")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Meta+BracketLeft");
  await expect(grid).toHaveAttribute("data-space-id", "sp-main");
  await expect(paneEl(page, "p-3")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Meta+BracketLeft");
  await expect(paneEl(page, "p-1")).toHaveAttribute("data-focused", "true");
  await expect(page.getByTestId("top-bar-back")).toBeDisabled();

  // cmd+] and the top bar's forward button go the other way, back into Release.
  await page.keyboard.press("Meta+BracketRight");
  await expect(paneEl(page, "p-3")).toHaveAttribute("data-focused", "true");
  await page.getByTestId("top-bar-forward").click();
  await expect(grid).toHaveAttribute("data-space-id", "sp-rel");
  await expect(paneEl(page, "p-8")).toHaveAttribute("data-focused", "true");
});

test("the top bar drags the window, and its controls still take clicks", async ({ page }) => {
  await seed([MAIN, RELEASE, REVIEWS]);
  await openShell(page);
  const draggable = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim());
  expect(await draggable('[data-testid="top-bar"]')).toBe("drag");
  for (const sel of ['[data-testid="space-tab"]', '[data-testid="top-bar-new-space"]', '[data-testid="top-bar-back"]', '[data-testid="top-bar-sidebar-toggle"]']) expect(await draggable(sel), sel).toBe("no-drag");
  // The app name and the bar's empty part drag; the strip of a pane does not (it is the pane's grip).
  expect(await draggable('[data-testid="top-bar-app-name"]')).toBe("drag");
  expect(await draggable('[data-testid="shell-tab-strip"]')).toBe("no-drag");

  await spaceTab(page, "sp-rel").click();
  await expect(page.getByTestId("shell-grid")).toHaveAttribute("data-space-id", "sp-rel");
  await page.getByTestId("top-bar-sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await page.getByTestId("top-bar-sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.getByTestId("top-bar-new-space").click();
  // A new space, shown at once, its name ready to type.
  await expect(page.getByTestId("space-tab")).toHaveCount(4);
  const field = page.getByTestId("space-name-field");
  await expect(field).toBeFocused();
  await field.fill("Scratch");
  await field.press("Enter");
  await expect(page.locator('[data-testid="space-tab"][data-current="true"]')).toHaveText("Scratch");
  await expect(page.getByTestId("shell-grid")).not.toHaveAttribute("data-space-id", "sp-rel");
});

/** SHOTS=<dir>: the top bar with three spaces and a badge, a tab over a space tab, the remove dialog, Move to space ▸; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`spaces screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    // s-2 waits on a permission in Release: its tab counts 1.
    await seed([MAIN, RELEASE, REVIEWS]);
    await openShell(page);
    await expect(spaceTab(page, "sp-rel").getByTestId("space-tab-count")).toHaveText("1");
    await page.mouse.move(700, 880);
    await still(page);
    await page.screenshot({ path: at("top-bar") });
    await page.screenshot({ path: at("top-bar-close"), clip: { x: 0, y: 0, width: 900, height: 120 } });

    await lift(page, centre(await boxOf(page, '[data-testid="shell-tab"][data-tab-id="t-diff-s-1"]')), centre(await boxOf(page, '[data-testid="space-tab"][data-space-id="sp-rev"]')));
    await expect(spaceTab(page, "sp-rev")).toHaveAttribute("data-drop-target", "true");
    await still(page);
    await page.screenshot({ path: at("drag-over-space"), clip: { x: 0, y: 0, width: 1000, height: 240 } });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
    await page.mouse.up();

    await spaceTab(page, "sp-rel").click({ button: "right" });
    await page.getByTestId("space-tab-remove").click();
    await expect(page.getByTestId("remove-space-dialog")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("remove-dialog") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("remove-space-dialog")).toHaveCount(0);

    await paneEl(page, "p-1").getByTestId("thread-header-menu-trigger").click();
    await page.getByTestId("menu-move-to-space").hover({ position: { x: 40, y: 8 } });
    await page.getByTestId("menu-move-to-space").hover({ position: { x: 20, y: 8 } });
    await expect(page.getByTestId("menu-move-to-space-spaces")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("move-to-space") });
  });
}
