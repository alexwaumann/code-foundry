import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, invocations, mockUrl, openStreams, resetMock } from "./fixtures";

/**
 * Full screen and the floating composer (docs/notes/shell-model.md, "Full screen"; docs/notes/
 * shell-19-rails-fullscreen.md), what only a browser shows: cmd+shift+enter and Escape through the
 * keymap, one pane over the whole grid with the others unmounted, the composer's expand, send,
 * drag and its reset when full screen ends. The state rules (keys inert, a tab switch keeping it,
 * which tabs float a composer, the draft) are vitest's (shell/fullscreen.test.ts,
 * components/shell/FloatingComposer.test.tsx). Set SHOTS=<dir> for the PR's screenshots.
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });

/** s-1's thread beside its diff, the diff focused. */
const TWO: Node = { t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1")]), pane("p-2", [diff("s-1"), thread("s-5")])], sizes: [0.5, 0.5] };

async function seed(root: Node, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
const floating = (page: Page) => page.getByTestId("floating-composer");
const watches = async () => (await openStreams())["ThreadService/WatchThread"] ?? 0;

/** Where the floating composer is: its centre and bottom (it is anchored there; its height follows its content). */
async function spot(page: Page): Promise<{ cx: number; bottom: number }> {
  const b = await boxOf(page, "floating-composer");
  return { cx: Math.round(b.x + b.w / 2), bottom: Math.round(b.y + b.h) };
}

async function boxOf(page: Page, testId: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** Full screen on the focused diff, by its key. */
async function fullscreenDiff(page: Page): Promise<void> {
  await seed(TWO, "p-2");
  await openShell(page);
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  await paneEl(page, "p-2").getByTestId("shell-pane-body").click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);
}

test.beforeEach(async () => {
  await resetMock();
});

test("cmd+shift+enter shows the pane over the whole grid, the others unmounted; Escape and the exit control leave", async ({ page }) => {
  await fullscreenDiff(page);
  const grid = await boxOf(page, "shell-grid");
  const full = await paneEl(page, "p-2").boundingBox();
  expect([Math.round(full?.width ?? 0), Math.round(full?.height ?? 0)]).toEqual([Math.round(grid.w), Math.round(grid.h)]);
  // The thread's pane is not mounted: no conversation and no stream behind the diff.
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect.poll(watches).toBe(0);
  // The top bar and the sidebar stay.
  await expect(page.getByTestId("top-bar")).toBeVisible();
  await expect(page.getByTestId("shell-fullscreen-exit")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  await expect.poll(watches).toBe(1);

  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);
  await page.getByTestId("shell-fullscreen-exit").click();
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  // The strip's button turns it on too, and the same key leaves.
  await paneEl(page, "p-1").getByTestId("shell-fullscreen").click();
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);
  await expect(paneEl(page, "p-1")).toHaveAttribute("data-fullscreen", "true");
  // A thread's own tab has its composer: nothing floats.
  await expect(floating(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
});

test("full screen from a rail moves the keyboard into the thread's prompt, and Escape there leaves", async ({ page }) => {
  // s-1 focused beside s-5's thread, in a grid too narrow for both: s-5's pane is a rail.
  await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread("s-1")]), pane("p-2", [thread("s-5")])], sizes: [0.5, 0.5] }, "p-1");
  await openShell(page);
  const grid = await boxOf(page, "shell-grid");
  await page.setViewportSize({ width: Math.round(1400 - grid.w + 600), height: 900 });
  const rail = page.locator('[data-testid="shell-rail"][data-pane-id="p-2"]');
  await expect(rail).toBeVisible();
  await rail.getByTestId("shell-rail-fullscreen").click();
  await expect(paneEl(page, "p-2")).toHaveAttribute("data-fullscreen", "true");
  // The pane took the focus, so the keyboard is in its prompt, whose editor marks every Escape
  // handled: full screen must still leave (docs/notes/shell-25b-audits.md).
  await expect(paneEl(page, "p-2").getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shell-fullscreen-exit")).toHaveCount(0);
  await expect(paneEl(page, "p-2").getByTestId("composer-input")).toBeFocused();
  // And again by its key, from the prompt.
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(paneEl(page, "p-2")).toHaveAttribute("data-fullscreen", "true");
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.getByTestId("shell-fullscreen-exit")).toHaveCount(0);
});

test("the floating composer: a pill; ⌘L expands it; a send reaches the thread and collapses it", async ({ page }) => {
  await fullscreenDiff(page);
  await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
  await expect(page.getByTestId("floating-composer-pill")).toContainText("Message");
  await page.keyboard.press("Meta+l");
  await expect(floating(page)).toHaveAttribute("data-expanded", "true");
  const input = floating(page).getByTestId("composer-input");
  await expect(input).toBeFocused();
  // The expanded composer holds the thread's Watch (for its docked asks).
  await expect.poll(watches).toBe(1);
  // The chip sits centred above the composer.
  const chip = await boxOf(page, "floating-composer-chip");
  const card = await floating(page).getByTestId("thread-composer").boundingBox();
  if (!card) throw new Error("no card");
  // The thread pane's composer width (720), whatever its text.
  expect(Math.round(card.width)).toBe(720);
  expect(Math.abs(chip.x + chip.w / 2 - (card.x + card.width / 2))).toBeLessThanOrEqual(1);
  expect(chip.y + chip.h).toBeLessThanOrEqual(card.y);

  await page.keyboard.type("Drop the added line and rerun the diff tests");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args).toMatchObject({ id: "s-1", text: "Drop the added line and rerun the diff tests" });
  await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
  await expect.poll(watches).toBe(0);
});

test("the draft is the thread's own: typed in the floating composer, it is in the thread's pane after", async ({ page }) => {
  await fullscreenDiff(page);
  await page.getByTestId("floating-composer-pill").click();
  await page.keyboard.type("Half a thought");
  // Escape collapses the composer first; a second leaves full screen.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  await expect(paneEl(page, "p-1").getByTestId("composer-input")).toHaveText("Half a thought");
});

test("the chip drags the composer, collapsed or expanded, without toggling; a click toggles; the drag ends with full screen", async ({ page }) => {
  await fullscreenDiff(page);
  await page.getByTestId("floating-composer-pill").click();
  await expect(floating(page).getByTestId("composer-input")).toBeFocused();
  const start = await spot(page);
  const chip = await boxOf(page, "floating-composer-chip");
  await page.mouse.move(chip.x + 20, chip.y + chip.h / 2);
  await page.mouse.down();
  await page.mouse.move(chip.x - 20, chip.y + chip.h / 2 - 100, { steps: 4 });
  await page.mouse.move(chip.x - 80, chip.y + chip.h / 2 - 250, { steps: 4 });
  await page.mouse.up();
  const moved = await spot(page);
  expect([moved.cx - start.cx, moved.bottom - start.bottom]).toEqual([-100, -250]);
  // The drag did not toggle it.
  await expect(floating(page)).toHaveAttribute("data-expanded", "true");
  // A click on the chip collapses it, where it was dragged (the pill too); a click on the pill expands it there.
  await page.getByTestId("floating-composer-chip").click();
  await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
  expect(await spot(page)).toEqual(moved);
  // The pill drags too, and stays collapsed.
  const pill = await boxOf(page, "floating-composer-pill");
  await page.mouse.move(pill.x + 20, pill.y + pill.h / 2);
  await page.mouse.down();
  await page.mouse.move(pill.x + 60, pill.y + pill.h / 2 - 20, { steps: 4 });
  await page.mouse.move(pill.x + 70, pill.y + pill.h / 2 - 50, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
  const movedPill = await spot(page);
  expect([movedPill.cx - moved.cx, movedPill.bottom - moved.bottom]).toEqual([50, -50]);
  await page.getByTestId("floating-composer-pill").click();
  await expect(floating(page)).toHaveAttribute("data-expanded", "true");
  expect((await spot(page)).cx).toBe(movedPill.cx);
  // Dragged far off: it stays inside the pane.
  const chip2 = await boxOf(page, "floating-composer-chip");
  await page.mouse.move(chip2.x + 20, chip2.y + chip2.h / 2);
  await page.mouse.down();
  await page.mouse.move(chip2.x - 2000, chip2.y + 2000, { steps: 6 });
  await page.mouse.up();
  const pane = await paneEl(page, "p-2").boundingBox();
  const kept = await boxOf(page, "floating-composer");
  if (!pane) throw new Error("no pane");
  expect(kept.x).toBeGreaterThanOrEqual(pane.x);
  expect(kept.y + kept.h).toBeLessThanOrEqual(pane.y + pane.height);
  // Full screen ends: next time it opens at its spot, collapsed.
  await page.getByTestId("shell-fullscreen-exit").click();
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  await paneEl(page, "p-2").getByTestId("shell-fullscreen").click();
  await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
  expect((await spot(page)).bottom).toBe(start.bottom);
  await page.getByTestId("floating-composer-pill").click();
  expect(await spot(page)).toEqual(start);
});

/** SHOTS=<dir>: full screen on a diff with the composer as a pill and expanded, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell full screen screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await fullscreenDiff(page);
    await expect(page.getByTestId("floating-composer-pill")).toBeVisible();
    await page.mouse.move(700, 120);
    await page.screenshot({ path: `${shots ?? ""}/shell-fullscreen-pill${suffix}.png` });
    await page.getByTestId("floating-composer-pill").click();
    await page.keyboard.type("The added line in .pr1853.diff should not be there. Drop it, keep the rest of the hunk, and rerun the diff tests.");
    await page.mouse.move(700, 120);
    await page.screenshot({ path: `${shots ?? ""}/shell-fullscreen-composer${suffix}.png` });
  });
}
