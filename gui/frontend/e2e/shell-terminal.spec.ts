import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, mockUrl, openStreams, resetMock } from "./fixtures";

/**
 * Terminal tabs and the quick terminal in the window shell (docs/notes/shell-13-terminals.md),
 * against the mock's layout seeded per test. What only a browser shows: xterm drawing in a tab and
 * in the quick slot, the Attach streams of visible and hidden terminals, and the quick terminal
 * pushing the conversation up or overlaying the pane at two pane heights, opened by cmd+j through
 * the keymap. Names, icons, the hint's condition, cmd+j's states and the restored line are
 * vitest's (lib/terminalName, shell/quickTerminal, shell/terminalActions, components/shell).
 * Set SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Node = { t: "pane"; id: string; tabs: Record<string, unknown>[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string) => ({ id: `t-${id}`, kind: "thread", thread: id });
const terminal = (tab: string, terminalId: string, thread = "") => ({ id: tab, kind: "terminal", ...(thread ? { thread } : {}), params: { terminal: terminalId } });
const pane = (id: string, tabs: Record<string, unknown>[], active = String(tabs[0]?.id)): Node => ({ t: "pane", id, tabs, active });

/** Thread s-1 beside a pane of two terminal tabs: s-1's shell (active) and the free `top`. */
const BESIDE: Node = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [pane("p-1", [thread("s-1")]), pane("p-2", [terminal("t-shell", "t-s1-shell", "s-1"), terminal("t-top", "t-top")])],
  sizes: [0.55, 0.45],
};

async function seed(root: Node | null, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

const attaches = async () => (await openStreams())["TerminalService/Attach"] ?? 0;

/** cmd+j from the thread's prompt: its quick terminal opens under the conversation, attached. */
async function openQuick(page: Page): Promise<void> {
  await page.getByTestId("composer-input").first().click();
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("quick-terminal-host")).toHaveAttribute("data-attach-phase", "live");
}

async function rect(page: Page, testId: string): Promise<{ top: number; bottom: number }> {
  const b = await page.getByTestId(testId).first().boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return { top: b.y, bottom: b.y + b.height };
}

test.beforeEach(async () => {
  await resetMock();
});

test("xterm draws in a terminal tab; only the visible terminals hold an Attach stream", async ({ page }) => {
  await seed(BESIDE, "p-1");
  await openShell(page);
  const host = page.getByTestId("shell-terminal-host");
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  await expect(host).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect(host.locator(".xterm-screen")).toBeVisible();
  // The `top` tab is behind: no stream for it.
  await expect.poll(attaches).toBe(1);

  await page.locator('[data-testid="shell-tab"][data-tab-id="t-top"] [role="tab"]').click();
  await expect(host).toHaveAttribute("data-terminal-id", "t-top");
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attaches).toBe(1);

  // The quick terminal under the thread is one more, and closing it gives it back.
  await openQuick(page);
  await expect(page.getByTestId("quick-terminal-host").locator(".xterm-screen")).toBeVisible();
  await expect.poll(attaches).toBe(2);
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("quick-terminal")).toHaveCount(0);
  await expect.poll(attaches).toBe(1);
});

test("the quick terminal pushes the conversation up in a tall pane and overlays a short one", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(pane("p-1", [thread("s-1")]), "p-1");
  await openShell(page);
  await openQuick(page);
  const quick = page.getByTestId("quick-terminal");
  await expect(quick).toHaveAttribute("data-mode", "push");
  // Pushed: the composer sits above it, untouched.
  const pushed = await rect(page, "quick-terminal");
  const dock = await page.locator('[data-testid="thread-pane"] .dock').boundingBox();
  if (!dock) throw new Error("no dock");
  expect(dock.y + dock.height).toBeLessThanOrEqual(pushed.top + 1);

  // A short window: the composer and 120px of conversation no longer fit above it, so it overlays.
  await page.setViewportSize({ width: 1400, height: 520 });
  await expect(quick).toHaveAttribute("data-mode", "overlay");
  const over = await rect(page, "quick-terminal");
  const body = await rect(page, "shell-pane-body");
  expect(Math.abs(over.bottom - body.bottom)).toBeLessThan(2);
  const dock2 = await page.locator('[data-testid="thread-pane"] .dock').boundingBox();
  if (!dock2) throw new Error("no dock");
  expect(dock2.y + dock2.height).toBeGreaterThan(over.top + 10);

  // Taller again: it pushes again.
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(quick).toHaveAttribute("data-mode", "push");
});

/** SHOTS=<dir>: a terminal tab, the quick terminal pushing and overlaying, and the Reset hint; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell terminal screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const out = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    // A terminal tab running `make dev`, beside its thread, with an idle shell behind it.
    await mockPost("terminal/facts?id=t-s1-shell&foreground=make%20dev");
    await seed(BESIDE, "p-1");
    await openShell(page);
    await expect(page.getByTestId("shell-terminal-host")).toHaveAttribute("data-attach-phase", "live");
    await expect(page.locator('[data-testid="shell-tab"][data-tab-id="t-shell"]')).toContainText("make dev");
    await page.mouse.move(700, 880);
    await page.screenshot({ path: out("terminal-tab") });

    // The quick terminal pushing.
    await seed(pane("p-1", [thread("s-1")]), "p-1");
    await openQuick(page);
    await expect(page.getByTestId("quick-terminal")).toHaveAttribute("data-mode", "push");
    await page.screenshot({ path: out("quick-push") });

    // The hint: the shell left the thread's directory.
    await page.keyboard.type("cd /tmp");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("terminal-cwd-reset")).toBeVisible();
    await page.screenshot({ path: out("quick-hint") });

    // Overlaying, in a short window.
    await page.setViewportSize({ width: 1400, height: 520 });
    await expect(page.getByTestId("quick-terminal")).toHaveAttribute("data-mode", "overlay");
    await page.screenshot({ path: out("quick-overlay") });
  });
}
