import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, expectTooltip, invocations, mockPost, mockUrl, openApp, openProjects, openStreams, resetMock, row, threadPrompt, writes } from "./fixtures";

// The bottom terminal panel (docs/notes/bottom-panel-2-gui.md, bottom-panel-autoshell.md).
// Mock seeds: t-s1-shell is thread s-1's shell, t-top a shell of the feat/sidebar worktree
// (the Projects page's). s-2 and s-3 have none, so opening their panel starts one.
const CFW = `${CF}.worktrees`;

test.beforeEach(async () => {
  await resetMock();
});

const bottom = (page: Page) => page.getByTestId("bottom-panel");
const tabs = (page: Page) => bottom(page).getByRole("tab");
const host = (page: Page) => page.getByTestId("bottom-terminal-host");

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
  });
}

/** data-region of the focused element ("bottom", "content", ...). */
function region(page: Page) {
  return page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") ?? null);
}

/** Whether keyboard focus is in the bottom panel's terminal (xterm's textarea). */
function focusInBottomTerminal(page: Page) {
  return page.evaluate(() => document.activeElement?.closest('[data-testid="bottom-terminal-host"]') !== null);
}

async function selectThread(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

/** TerminalService.Create with labels, as a CLI or another window would start a shell (no focus intent). */
async function createShell(labels: Record<string, string>, cwd: string): Promise<string> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.TerminalService/Create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ argv: ["/bin/zsh"], cwd, labels }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { terminal: { id: string } }).terminal.id;
}

const threadShell = (thread: string, worktree = CF) => ({ kind: "shell", thread: thread, repo: "repo-cf", worktree });

async function attachStreams(): Promise<number> {
  return (await openStreams())["TerminalService/Attach"] ?? 0;
}

test("the header toggle and cmd+j show and hide a thread's bottom panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await expect(bottom(page)).toHaveCount(0);
  const toggle = page.getByTestId("thread-header").getByTestId("bottom-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expectTooltip(page, toggle, "Toggle Bottom Panel");
  // Immediately left of the side panel's toggle.
  const toggles = page.getByTestId("thread-header").locator('[data-testid="bottom-toggle"] + [data-testid="panel-toggle"]');
  await expect(toggles).toHaveCount(1);

  await toggle.click();
  await expect(bottom(page)).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // The thread's shell, titled by its cwd's last segment, active and attached, with focus.
  await expect(tabs(page)).toHaveText(["code-foundry"]);
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
  await expectTooltip(page, tabs(page).first(), "~/src/code-foundry");
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  await expect.poll(() => region(page)).toBe("bottom");

  // Same width as the content pane, a shell gap (12px) under it, 12px above the window's bottom edge, 280 high.
  const content = await box(page, "content-pane");
  const wrapper = await box(page, "bottom-panel-wrapper");
  expect([wrapper.left, wrapper.right]).toEqual([content.left, content.right]);
  expect(wrapper.top - content.bottom).toBe(12);
  expect((page.viewportSize()?.height ?? 0) - wrapper.bottom).toBe(12);
  expect(wrapper.height).toBe(280);
  // The header strip is no drag surface.
  expect(await page.getByTestId("bottom-header").evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim())).toBe("no-drag");

  // cmd+j from the bottom terminal hides it and returns focus to the thread.s prompt.
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => region(page)).toBe("content");
  // And from there brings it back, focused.
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toBeVisible();
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  // The close button at the strip's right end hides it too.
  await bottom(page).getByTestId("bottom-close").click();
  await expect(bottom(page)).toHaveCount(0);
  // All of it is window-local: no round trip to the daemon.
  expect((await invocations()).filter((i) => i.name === "view.bottom.toggle")).toEqual([]);
});

test("the palette returns to the bottom panel, and the panel is per thread", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);

  // s-2 has no shells and its own (closed) panel: Toggle Bottom Panel from the palette
  // opens it with a new shell, which the palette returns to.
  await selectThread(page, "s-2");
  await expect(bottom(page)).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Toggle Bottom Panel");
  await page.getByTestId("palette").locator('[data-command="view.bottom.toggle"]').click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["ghostty-playground"]);
  await expect(host(page)).toHaveAttribute("data-terminal-id", /^t-new-/);
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  await selectThread(page, "s-1");
  await expect(tabs(page)).toHaveText(["code-foundry"]);
});

test('the toggle and "+" start shells for the thread, which open there focused', async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-2");
  // The header's toggle on a thread without shells: the panel opens with one.
  await page.getByTestId("bottom-toggle").click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("terminal.new");
  expect((await invocations()).at(-1)?.context).toMatchObject({ activeThreadId: "s-2" });
  await expect(tabs(page)).toHaveCount(1);
  const first = await host(page).getAttribute("data-terminal-id");
  expect(first).toMatch(/^t-new-/);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);

  // "+" after the tabs: a second shell, active, focused.
  await bottom(page).getByTestId("bottom-new-terminal").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(host(page)).not.toHaveAttribute("data-terminal-id", first ?? "");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  // cmd+t from the bottom terminal (a registry chord the terminal yields): a third, focused.
  const second = await host(page).getAttribute("data-terminal-id");
  await page.keyboard.press("Meta+t");
  await expect(tabs(page)).toHaveCount(3);
  await expect(host(page)).not.toHaveAttribute("data-terminal-id", second ?? "");
  await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  // Three shells in one folder: numbered after the first.
  await expect(tabs(page)).toHaveText(["ghostty-playground", "ghostty-playground 2", "ghostty-playground 3"]);
  // The thread stays selected: its shells have no sidebar rows.
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
});

test("a stopped thread has the toggle left of the side panel's, and its panel", async ({ page }) => {
  await openApp(page);
  // s-3 is stopped; a shell it owns keeps running.
  await row(page, "s:s-3").click();
  await expect(page.getByTestId("thread-composer")).toBeVisible();
  const header = page.getByTestId("thread-header");
  const pair = header.locator('[data-testid="bottom-toggle"] + [data-testid="panel-toggle"]');
  await expect(pair).toHaveCount(1);
  await header.getByTestId("bottom-toggle").click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  expect((await invocations()).at(-1)?.context).toMatchObject({ activeThreadId: "s-3" });
  await expect(page.getByTestId("thread-composer")).toBeVisible();
});

test("× and cmd+w close terminals through terminal.close; closing the last one hides the panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await bottom(page).getByTestId("bottom-new-terminal").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(host(page)).not.toHaveAttribute("data-terminal-id", "t-s1-shell");
  const second = await host(page).getAttribute("data-terminal-id");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);

  // cmd+w in the terminal closes the active one; the last tab left becomes active.
  await page.keyboard.press("Meta+w");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("terminal.close");
  const close = (await invocations()).at(-1);
  expect(close?.args).toEqual({ id: second });
  expect(close?.context?.activeTerminalId).toBe(second);
  await expect(tabs(page)).toHaveText(["code-foundry"]);
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);

  // The × on the last tab: the panel hides and the content pane takes the keyboard.
  const tab = bottom(page).locator('[data-tab-id="t-s1-shell"]');
  await tab.hover();
  await tab.getByRole("button", { name: "Close code-foundry" }).click();
  await expect.poll(async () => (await invocations()).at(-1)?.args).toEqual({ id: "t-s1-shell" });
  await expect(bottom(page)).toHaveCount(0);
  await expect(page.getByTestId("thread-header").getByTestId("bottom-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => region(page)).toBe("content");
  await expect.poll(attachStreams).toBe(0);
});

test("the resize handle sizes one panel by keyboard and double-click, and the height persists", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  const handle = page.getByTestId("bottom-resize-handle");
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  await expect(handle).toHaveAttribute("aria-valuenow", "280");
  await expect(handle).toHaveAttribute("aria-valuemin", "120");
  // 70% of the content column (800 - 2 × 12).
  await expect(handle).toHaveAttribute("aria-valuemax", String(Math.floor(776 * 0.7)));
  // The handle fills the 12px gap above the panel.
  const h = await box(page, "bottom-resize-handle");
  expect(h.bottom).toBe((await box(page, "bottom-panel-wrapper")).top);
  expect(h.top).toBe((await box(page, "content-pane")).bottom);

  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "296");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "360");
  await page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "344");
  expect((await box(page, "bottom-panel-wrapper")).height).toBe(344);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "120");
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "543");

  // Dragging up makes it taller.
  await page.keyboard.press("Home");
  const before = await box(page, "bottom-resize-handle");
  await page.mouse.move(640, before.top + 4);
  await page.mouse.down();
  await page.mouse.move(640, before.top - 96, { steps: 4 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "220");

  // s-2's panel keeps the default.
  await selectThread(page, "s-2");
  await page.getByTestId("bottom-toggle").click();
  await expect(page.getByTestId("bottom-resize-handle")).toHaveAttribute("aria-valuenow", "280");

  // After a reload s-1's height and open state come back; double-click resets it.
  await page.reload();
  await selectThread(page, "s-1");
  await expect(bottom(page)).toBeVisible();
  await expect(page.getByTestId("bottom-resize-handle")).toHaveAttribute("aria-valuenow", "220");
  await page.getByTestId("bottom-resize-handle").dblclick();
  await expect(page.getByTestId("bottom-resize-handle")).toHaveAttribute("aria-valuenow", "280");
});

test("no bottom panel on the dashboard, the Pull Requests page, settings, or under an expanded side panel", async ({ page }) => {
  await openApp(page);
  // The dashboard: no toggle, and cmd+j does nothing.
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toHaveCount(0);
  await expect(page.getByTestId("bottom-toggle")).toHaveCount(0);

  await page.getByTestId("nav-pullrequests").click();
  await expect(page.getByTestId("prs-page")).toBeVisible();
  await expect(page.getByTestId("bottom-toggle")).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toHaveCount(0);

  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await expect(bottom(page)).toBeVisible();
  // Leaving for the Pull Requests page hides it (and detaches), coming back shows it.
  await page.getByTestId("nav-pullrequests").click();
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(attachStreams).toBe(0);
  await selectThread(page, "s-1");
  await expect(bottom(page)).toBeVisible();

  // Settings hides it; cmd+j is a no-op meanwhile.
  await page.getByTestId("status-settings").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(bottom(page)).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  await page.getByTestId("status-settings").click();
  await expect(bottom(page)).toBeVisible();

  // The side panel expanded over the content column hides it too, and detaches it.
  await page.getByTestId("thread-header").getByTestId("panel-toggle").click();
  await page.getByTestId("panel-expand").click();
  await expect(page.getByTestId("side-panel-wrapper")).toHaveAttribute("data-expanded", "true");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(attachStreams).toBe(0);
  await page.getByTestId("panel-expand").click();
  await expect(bottom(page)).toBeVisible();
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
});

test("the Projects page's panel lists the worktree shells; its + starts one in the active tab's worktree", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const toggle = page.getByTestId("projects-page").getByTestId("bottom-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  // t-top (feat/sidebar), titled by its worktree's folder; thread shells are not here.
  await expect(tabs(page)).toHaveText(["feat-sidebar"]);
  await expectTooltip(page, tabs(page).first(), "~/src/code-foundry.worktrees/feat-sidebar");
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-top");

  await bottom(page).getByTestId("bottom-new-terminal").click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("terminal.new");
  expect((await invocations()).at(-1)?.context).toMatchObject({ activeRepoId: "repo-cf", activeWorktreePath: `${CFW}/feat-sidebar`, activeThreadId: "" });
  await expect(tabs(page)).toHaveText(["feat-sidebar", "feat-sidebar 2"]);
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("projects-page")).toBeVisible();

  // A worktree row's New terminal here lands in the same panel.
  const dot = page.locator(`[data-nav-key="pw:repo-dot::/Users/dev/dotfiles"]`);
  await dot.hover();
  await dot.getByTestId("worktree-new-terminal").click();
  await expect(tabs(page)).toHaveText(["feat-sidebar", "feat-sidebar 2", "dotfiles"]);
  await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
});

test("a new shell opens its owner's panel with it active, whether or not the owner is selected", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await threadPrompt(page).click();
  await expect.poll(() => region(page)).toBe("content");

  // Started elsewhere (no focus intent): s-1's panel opens with it active; focus stays put.
  const mine = await createShell(threadShell("s-1"), CF);
  await expect(bottom(page)).toBeVisible();
  await expect(tabs(page)).toHaveCount(2);
  await expect(host(page)).toHaveAttribute("data-terminal-id", mine);
  await expect(bottom(page).locator(`[data-tab-id="${mine}"]`).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  expect(await region(page)).toBe("content");

  // For s-2, which is not selected: nothing changes here, but its panel is open on it.
  const other = await createShell(threadShell("s-2", "/Users/dev/src/ghostty-playground"), "/Users/dev/src/ghostty-playground");
  await expect(host(page)).toHaveAttribute("data-terminal-id", mine);
  await selectThread(page, "s-2");
  await expect(bottom(page)).toBeVisible();
  await expect(host(page)).toHaveAttribute("data-terminal-id", other);
});

test("only the active tab of the visible panel holds an Attach stream", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  expect(await attachStreams()).toBe(0);
  await page.getByTestId("bottom-toggle").click();
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);
  // A second shell from elsewhere: the keyboard is in the panel, so it only gets a tab.
  const second = await createShell(threadShell("s-1"), CF);
  await expect(tabs(page)).toHaveCount(2);
  await tabs(page).nth(1).click();
  await expect(host(page)).toHaveAttribute("data-terminal-id", second);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);

  // Switching tabs re-attaches the one host: still one bottom stream.
  await tabs(page).first().click();
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  // Left/Right move between tabs without activating; Enter activates.
  await tabs(page).first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs(page).nth(1)).toBeFocused();
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(host(page)).toHaveAttribute("data-terminal-id", second);
  await expect.poll(attachStreams).toBe(1);

  // Hiding the panel detaches it.
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(attachStreams).toBe(0);
});

test("a shell this window did not start does not take the keyboard from the bottom panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  await page.keyboard.type("ec");
  const other = await createShell(threadShell("s-1"), CF);
  // Its tab shows up, but the tab being typed in stays active and keeps the keys.
  await expect(bottom(page).locator(`[data-tab-id="${other}"]`)).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  expect(await focusInBottomTerminal(page)).toBe(true);
  await page.keyboard.type("ho");
  await expect.poll(async () => (await writes()).filter((w) => w.id === "t-s1-shell").map((w) => w.data).join("")).toBe("echo");
  expect((await writes()).some((w) => w.id === other)).toBe(false);
});

test("expanding the side panel from the bottom panel moves the keyboard to the side panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await page.getByTestId("thread-header").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
  // Back into the bottom shell, then the side panel's expand button (it keeps focus where it is).
  await host(page).click();
  await expect.poll(() => region(page)).toBe("bottom");
  await page.getByTestId("panel-expand").click();
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("panel");
});

test("switching between two threads with open panels keeps one bottom stream", async ({ page }) => {
  await openApp(page);
  const s2shell = await createShell(threadShell("s-2", "/Users/dev/src/ghostty-playground"), "/Users/dev/src/ghostty-playground");
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect.poll(attachStreams).toBe(1);
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  // cmd+1 jumps to the first thread (s-2, waiting on the user): its prompt takes the keyboard.
  await page.keyboard.press("Meta+1");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await expect(host(page)).toHaveAttribute("data-terminal-id", s2shell);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);
  await expect.poll(() => region(page)).toBe("content");
  // And back.
  await selectThread(page, "s-1");
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect.poll(attachStreams).toBe(1);
});

test("the resize handle is part of the panel: cmd+j from it hides the panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await page.getByTestId("bottom-resize-handle").focus();
  await expect.poll(() => region(page)).toBe("bottom");
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");
});

test("the Usage page hides the panel and brings it back when it closes", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await expect(bottom(page)).toBeVisible();
  await page.getByTestId("status-usage").click();
  await expect(page.getByTestId("usage-page")).toBeVisible();
  await expect(bottom(page)).toHaveCount(0);
  // No Attach stream at all (a thread has no terminal of its own).
  await expect.poll(attachStreams).toBe(0);
  // cmd+j is a no-op meanwhile.
  await page.keyboard.press("Meta+j");
  await page.getByTestId("usage-page-close").click();
  await expect(bottom(page)).toBeVisible();
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
});

test("cmd+j on a thread without shells starts one; its exit hides the panel; the next cmd+j starts a fresh one", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-2");
  await threadPrompt(page).click();
  // terminal.new takes a moment: the panel opens at once, blank (no "No terminals" flash).
  await mockPost("terminal/new?delay=600");
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toBeVisible();
  await expect(bottom(page).getByTestId("bottom-body")).toHaveAttribute("data-starting", "true");
  await expect(bottom(page).getByTestId("bottom-empty")).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["ghostty-playground"]);
  await expect(bottom(page).getByTestId("bottom-body")).not.toHaveAttribute("data-starting", "true");
  const first = await host(page).getAttribute("data-terminal-id");
  expect(first).toMatch(/^t-new-/);
  const started = (await invocations()).filter((i) => i.name === "terminal.new");
  expect(started).toHaveLength(1);
  expect(started[0]?.context).toMatchObject({ activeThreadId: "s-2" });
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  await mockPost("terminal/new?delay=0");

  // The shell exits (`exit` typed): its tab goes, and with it the panel; the prompt takes the keyboard.
  await mockPost(`terminal/exit?id=${first ?? ""}&code=0`);
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");

  // cmd+j again: a fresh shell, not the empty state.
  await page.keyboard.press("Meta+j");
  await expect(tabs(page)).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-terminal-id", /^t-new-/);
  await expect(host(page)).not.toHaveAttribute("data-terminal-id", first ?? "");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  // Hiding stays a plain hide: no shell is closed or started.
  const before = (await invocations()).length;
  await page.keyboard.press("Meta+j");
  await expect(bottom(page)).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  await expect(tabs(page)).toHaveCount(1);
  expect((await invocations()).length).toBe(before);
});

test("the last shell of a panel that is not on screen exiting closes that panel too", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-2");
  await page.keyboard.press("Meta+j");
  await expect(tabs(page)).toHaveCount(1);
  const shell = await host(page).getAttribute("data-terminal-id");
  await selectThread(page, "s-1");
  await mockPost(`terminal/exit?id=${shell ?? ""}&code=0`);
  await selectThread(page, "s-2");
  await expect(bottom(page)).toHaveCount(0);
  await expect(page.getByTestId("thread-header").getByTestId("bottom-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("the Projects page: its last shell exiting hides the panel, and cmd+j then shows the empty state's hint", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await page.getByTestId("projects-page").getByTestId("bottom-toggle").click();
  await expect(tabs(page)).toHaveText(["feat-sidebar"]);
  await mockPost("terminal/exit?id=t-top&code=0");
  await expect(bottom(page)).toHaveCount(0);
  // No worktree to own a shell: the panel opens on the hint, and nothing is started.
  await page.getByTestId("projects-page").getByTestId("bottom-toggle").click();
  await expect(bottom(page).getByTestId("bottom-empty")).toContainText("Start one with New terminal on a project or worktree row.");
  expect((await invocations()).some((i) => i.name === "terminal.new")).toBe(false);
});

test("a daemon restart that pruned the shells leaves the panel closed; cmd+j starts a fresh one", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("bottom-toggle").click();
  await expect(host(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  await mockPost("daemon/restart");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");
  await page.keyboard.press("Meta+j");
  await expect(tabs(page)).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-terminal-id", /^t-new-/);
  // After a reload the panel comes back open, with the shell that is still there.
  await page.reload();
  await selectThread(page, "s-1");
  await expect(tabs(page)).toHaveCount(1);
});

test("a persisted open panel whose shells are gone comes back closed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("code-foundry.bottom", JSON.stringify({ state: { byKey: { "thread:s-2": { open: true } } }, version: 1 }));
  });
  await openApp(page);
  await selectThread(page, "s-2");
  await expect(bottom(page)).toHaveCount(0);
  await expect(page.getByTestId("thread-header").getByTestId("bottom-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("when terminal.new fails, the empty state is the fallback: its button retries, cmd+w hides it", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-2");
  await mockPost("terminal/new?fail=no%20shell%20for%20you");
  await page.keyboard.press("Meta+j");
  const empty = bottom(page).getByTestId("bottom-empty");
  await expect(empty).toContainText("No terminals");
  await expect(empty.getByTestId("bottom-empty-new")).toHaveText("New Terminal⌘T");
  await expect(tabs(page)).toHaveCount(0);
  await expect(host(page)).toBeHidden();
  // cmd+w with no tabs hides the panel and hands focus to the content pane.
  await bottom(page).focus();
  await page.keyboard.press("Meta+w");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");
  // It fails again on the next cmd+j (the empty state once more); its button then starts one.
  await mockPost("terminal/new?fail=again");
  await page.keyboard.press("Meta+j");
  await empty.getByTestId("bottom-empty-new").click();
  await expect(tabs(page)).toHaveCount(1);
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
});
