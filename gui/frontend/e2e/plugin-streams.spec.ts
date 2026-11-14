import { expect, test, type Page } from "@playwright/test";
import { mockPost, openHelloDemo, openStreams, resetMock } from "./fixtures";
import { paneShowing } from "./shell";

/**
 * Plugin thread and terminal nodes each hold their own stream, with nothing rationing them
 * (docs/notes/ws-remove-slots.md). The mock's hello demo "stress" tab shows two thread nodes
 * and a terminal: beside the event stream, the content pane's thread and the surface's own
 * stream that is six. It was once a stream for each of WebKit's connections to the daemon,
 * and every act hung behind them. Streams now ride sockets, which leave those connections
 * to calls, so all of them stay live and acts complete.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");

async function totalStreams(): Promise<number> {
  return Object.values(await openStreams()).reduce((a, b) => a + b, 0);
}

async function openStress(page: Page): Promise<void> {
  await openHelloDemo(page);
  await mockPost("plugin/demotab?tab=stress");
  await expect(surface(page).locator('[data-testid="plugin-tab"][data-key="stress"]')).toHaveAttribute("aria-selected", "true");
}

test.beforeEach(async () => {
  await resetMock();
});

test("two threads and a terminal in one view: all live at once, past the old limit, and acts still complete", async ({ page }) => {
  await openStress(page);
  const threads = surface(page).getByTestId("plugin-thread");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(threads).toHaveCount(2);
  await expect(threads.nth(0)).toHaveAttribute("data-live", "true");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect.poll(totalStreams).toBeGreaterThanOrEqual(6);

  // An act goes through (it hung with six streams open on fetch).
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("1 click");

  // Leaving the view tab ends the nodes' streams with the view.
  const before = await openStreams();
  await surface(page).locator('[data-testid="plugin-tab"][data-key="overview"]').click();
  await expect(surface(page).locator('[data-testid="plugin-tab"][data-key="overview"]')).toHaveAttribute("aria-selected", "true");
  await expect(surface(page).getByTestId("plugin-thread")).toHaveCount(0);
  await expect.poll(async () => (await openStreams())["TerminalService/Attach"] ?? 0).toBe((before["TerminalService/Attach"] ?? 0) - 1);
});

/** A free shell's tab over the focused surface: the palette's New Terminal in Home Folder (terminal.new-free; it has no key). */
async function newFreeShell(page: Page): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/commands.ts").then((m) => m.runCommandForResult("terminal.new-free", {}, { quiet: true }))`);
}

test("a terminal tab beside the nodes adds a stream and takes none from a node", async ({ page }) => {
  await openStress(page);
  const threads = surface(page).getByTestId("plugin-thread");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(3);
  await expect.poll(async () => (await openStreams())["TerminalService/Attach"] ?? 0).toBe(1);
  // A free shell's tab (the palette's New Terminal in Home Folder opens it over the focused surface),
  // moved into a pane of its own under the thread's: the thread, the nodes and the shell all on screen.
  const threadPane = (await paneShowing(page, "thread").getAttribute("data-pane-id")) ?? "";
  await newFreeShell(page);
  const shell = page.locator('[data-testid="shell-tab"][data-kind="terminal"]');
  await expect(shell).toHaveCount(1);
  const tabId = (await shell.getAttribute("data-tab-id")) ?? "";
  await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.applyLayout({ op: "move_tab", tab: ${JSON.stringify(tabId)}, pane: ${JSON.stringify(threadPane)}, edge: "bottom" }))`);
  await expect(page.getByTestId("shell-pane")).toHaveCount(3);
  // The surface takes the focus back: it draws for the window's selection (its thread's while it is focused).
  await page.locator('[data-testid="shell-tab"][data-kind^="plugin."] [role="tab"]').click();
  await expect(page.getByTestId("shell-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(threads.nth(0)).toHaveAttribute("data-live", "true");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  await expect.poll(async () => (await openStreams())["TerminalService/Attach"] ?? 0).toBe(2);
  expect((await openStreams())["ThreadService/WatchThread"]).toBe(3);
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("1 click");
});

test("a plugin surface linked to a thread keeps its view while an unlinked tab has the focus", async ({ page }) => {
  await openStress(page);
  const threadPane = (await paneShowing(page, "thread").getAttribute("data-pane-id")) ?? "";
  await newFreeShell(page);
  const shell = page.locator('[data-testid="shell-tab"][data-kind="terminal"]');
  await expect(shell).toHaveCount(1);
  const tabId = (await shell.getAttribute("data-tab-id")) ?? "";
  await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.applyLayout({ op: "move_tab", tab: ${JSON.stringify(tabId)}, pane: ${JSON.stringify(threadPane)}, edge: "bottom" }))`);
  await expect(page.getByTestId("shell-pane")).toHaveCount(3);
  await expect(page.locator('[data-testid="shell-pane"][data-focused]').getByTestId("shell-terminal-host")).toBeVisible();
  await expect(surface(page).getByTestId("plugin-unavailable")).toHaveCount(0);
  await expect(surface(page).getByTestId("plugin-thread").nth(1)).toHaveAttribute("data-live", "true");
});

// A wall four columns wide, each a grid of its own: what only a real layout settles. A grid inside
// columns first measures them stacked, so for a frame every node is 38 px wide and on screen.
const WALL_ROWS = 6;

function wallView(): Record<string, unknown> {
  const rows = Array.from({ length: WALL_ROWS }, (_, r) => r);
  const items = [0, 1, 2, 3].map((c) => ({
    key: `c${String(c)}`,
    children: [
      {
        key: `g${String(c)}`,
        grid: {
          minWidth: 160,
          items: rows.map((r) => ({
            key: `i${String(c)}-${String(r)}`,
            children: [{ key: `n${String(c)}-${String(r)}`, terminal: { terminalId: `t-wall-${String(c * WALL_ROWS + r)}`, title: "Wall", height: 240 } }],
          })),
        },
      },
    ],
  }));
  return { view: { nodes: [{ key: "cols", columns: { items } }] } };
}

const liveCount = (page: Page) => surface(page).locator('[data-live="true"]').count();
const attaches = async () => (await openStreams())["TerminalService/Attach"] ?? 0;

test("a wall holds a stream for what is on screen: never more at first, and scrolling swaps them", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockPost(`plugin/terminals?count=${String(4 * WALL_ROWS)}`);
  await openHelloDemo(page);
  // The surface's pane full screen: the whole pane area, as the expanded side panel was.
  const own = page.locator('[data-testid="shell-pane"]').filter({ has: page.locator('[data-testid="shell-tab"][data-kind^="plugin."][data-active]') });
  await own.getByTestId("shell-fullscreen").click();
  await expect(own).toHaveAttribute("data-fullscreen", "true");

  // The most live nodes at any moment, from before the view lands.
  // In the surface: full screen floats the thread's composer over the pane, which is live too.
  await page.evaluate(() => {
    const w = window as unknown as { __peakLive: number };
    w.__peakLive = 0;
    new MutationObserver(() => {
      w.__peakLive = Math.max(w.__peakLive, document.querySelectorAll('[data-testid="plugin-surface"] [data-live="true"]').length);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-live"] });
  });
  await mockPost(`plugin/demotab?tab=${encodeURIComponent(`view:${JSON.stringify(wallView())}`)}`);
  const first = surface(page).locator('[data-testid="plugin-terminal"][data-key="n0-0"]');
  const last = surface(page).locator(`[data-testid="plugin-terminal"][data-key="n3-${String(WALL_ROWS - 1)}"]`);
  await expect(first).toHaveAttribute("data-live", "true");
  await expect(surface(page).getByTestId("plugin-terminal")).toHaveCount(4 * WALL_ROWS);
  await expect(last.getByTestId("plugin-live-hidden")).toBeAttached();

  const atTop = await liveCount(page);
  expect(atTop).toBeLessThan(4 * WALL_ROWS);
  await expect.poll(attaches).toBe(atTop);
  expect(await page.evaluate(() => (window as unknown as { __peakLive: number }).__peakLive)).toBe(atTop);

  // Scrolled away, a node's stream closes; the ones it reaches open.
  const scroll = surface(page).getByTestId("plugin-scroll");
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(last).toHaveAttribute("data-live", "true");
  await expect(first).not.toHaveAttribute("data-live", "true");
  await expect(first.getByTestId("plugin-live-hidden")).toBeAttached();
  await expect.poll(async () => (await attaches()) === (await liveCount(page))).toBe(true);
  expect(await liveCount(page)).toBeLessThan(4 * WALL_ROWS);

  // And back.
  await scroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(first).toHaveAttribute("data-live", "true");
  await expect(last).not.toHaveAttribute("data-live", "true");
  await expect.poll(attaches).toBe(atTop);
});
