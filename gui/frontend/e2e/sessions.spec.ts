import { expect, test, type Page, type Request } from "@playwright/test";
import { UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";
import { CF, emit, invocations, mockPost, openApp, openStreams, resetMock, row } from "./fixtures";

const FIX_RESIZE = `${CF}.worktrees/fix-resize`;
const hasFocusSession = UiIntentSchema.fields.some((f) => f.localName === "focusSession");

test.beforeEach(async () => {
  await resetMock();
});

function badge(page: Page, sessionId: string) {
  return row(page, `s:${sessionId}`).locator("[data-session-badge]");
}

test("session rows render first under their worktree with status badges", async ({ page }) => {
  await openApp(page);
  const tree = page.getByRole("tree");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", /^(busy|idle)$/);
  await expect(badge(page, "s-2")).toHaveAttribute("data-session-badge", "attention");
  await expect(badge(page, "s-3")).toHaveAttribute("data-session-badge", "disconnected");
  await expect(badge(page, "s-4")).toHaveAttribute("data-session-badge", "disconnected");
  await expect(badge(page, "s-5")).toHaveAttribute("data-session-badge", "starting");
  await expect(badge(page, "s-6")).toHaveAttribute("data-session-badge", "closing");
  // Session-owned terminals have no row of their own.
  await expect(row(page, "t:t-claude")).toHaveCount(0);
  await expect(row(page, "t:t-ghostty")).toHaveCount(0);
  // Sessions come before plain terminals under a worktree.
  const keys = await tree.locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(keys.indexOf("s:s-4")).toBeLessThan(keys.indexOf("t:t-top"));
  expect(keys.indexOf("s:s-5")).toBeLessThan(keys.indexOf("t:t-top"));
  // Disconnected names are muted; starting settles into connected on the mock's timer.
  await expect(row(page, "s:s-3").getByTestId("session-name")).toHaveClass(/text-muted-foreground/);
  await expect(badge(page, "s-5")).toHaveAttribute("data-session-badge", /^(idle|busy)$/, { timeout: 12_000 });
});

test("a disconnected session shows the Not connected panel; Reconnect re-attaches", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-4").click();
  const panel = page.getByTestId("session-disconnected");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("disconnect-reason")).toHaveText("Crashed (exit code 139)");
  await expect(panel.getByTestId("last-activity")).toHaveText(/min ago/);
  await expect(page.getByTestId("terminal-host")).toHaveCount(0);

  await panel.getByTestId("reconnect").click();
  const host = page.getByTestId("terminal-host");
  await expect(host).toHaveAttribute("data-terminal-id", /^t-s-4-/);
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  await expect(page.getByTestId("session-indicator")).toHaveText("starting…");
  await expect(page.getByTestId("session-indicator")).toHaveCount(0, { timeout: 8000 });
  await expect(badge(page, "s-4")).toHaveAttribute("data-session-badge", "idle");
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("session.reconnect");
  expect(last?.context).toMatchObject({ activeSessionId: "s-4", activeView: "session" });
});

test("a live session that disconnects swaps to the panel, and Reconnect attaches the new terminal", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const host = page.getByTestId("terminal-host");
  await expect(host).toHaveAttribute("data-terminal-id", "t-claude");
  await expect(host).toHaveAttribute("data-attach-phase", "live");

  await mockPost("session/disconnect?id=s-1&reason=exited&code=0");
  await expect(page.getByTestId("disconnect-reason")).toHaveText("Claude exited");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", "disconnected");

  // Enter on the focused Reconnect button (keyboard path).
  await expect(page.getByTestId("reconnect")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(host).toHaveAttribute("data-terminal-id", /^t-s-1-/);
  await expect(host).toHaveAttribute("data-attach-phase", "live");
});

test("close shows closing… then the panel with the reason", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+Shift+w"); // session.close, yielded by the focused terminal
  await expect(page.getByTestId("session-indicator")).toHaveText("closing…");
  await expect(page.getByTestId("disconnect-reason")).toHaveText("Closed", { timeout: 8000 });
});

test("needs-attention: count badge, window title, and cmd+shift+a", async ({ page }) => {
  await openApp(page);
  const count = page.getByTestId("attention-badge");
  await expect(count).toHaveText("1");
  await expect(page).toHaveTitle("Code Foundry (1)");

  await mockPost("session/attention?id=s-1");
  await expect(count).toHaveText("2");
  await expect(page).toHaveTitle("Code Foundry (2)");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", "attention");

  // Sidebar order: s-1 (code-foundry) before s-2 (ghostty-playground); wraps around.
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a"); // from inside the focused terminal
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await count.click();
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");

  // Typing into a session that needed attention clears it (mock: input -> busy).
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.type("y");
  await expect(count).toHaveText("1");
  await expect(page).toHaveTitle("Code Foundry (1)");
});

test("new session: cmd+n prompts model and effort from the ArgSpec, then attaches", async ({ page }) => {
  await openApp(page);
  await row(page, `w:repo-cf::${FIX_RESIZE}`).click();
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "args");
  const option = (v: string) => palette.getByRole("option", { name: new RegExp(`^${v}( default)?$`) });
  for (const m of ["opus", "sonnet", "haiku"]) await expect(option(m)).toBeVisible();
  await expect(option("opus")).toContainText("default"); // ArgSpec.default_value is highlighted
  await option("haiku").click();
  for (const e of ["low", "medium", "high", "xhigh", "max"]) await expect(option(e)).toBeVisible();
  await page.keyboard.type("max");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);

  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("session.new");
  expect(last?.args).toEqual({ model: "haiku", effort: "max" });
  expect(last?.context?.activeWorktreePath).toBe(FIX_RESIZE);
  // The new session row appears under the worktree, selected, with its terminal attached.
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  const key = await created.getAttribute("data-row-key");
  const keys = await page.getByRole("tree").locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(keys.indexOf(key)).toBeGreaterThan(keys.indexOf(`w:repo-cf::${FIX_RESIZE}`));
  expect(keys.indexOf(key)).toBeLessThan(keys.indexOf("t:t-tests"));
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
});

test("new session: the sidebar + on a worktree opens the same prompts for that worktree", async ({ page }) => {
  await openApp(page);
  const wt = row(page, `w:repo-cf::${FIX_RESIZE}`);
  await wt.hover();
  await wt.getByTestId("new-session").click();
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "args");
  await page.keyboard.press("Enter"); // model: default (opus)
  await page.keyboard.press("Enter"); // effort: Default (not set)
  await expect(palette).toHaveCount(0);
  const last = (await invocations()).at(-1);
  expect(last).toMatchObject({ name: "session.new", args: { model: "opus" } });
  expect(last?.context?.activeWorktreePath).toBe(FIX_RESIZE);
});

test("rename inline: double-click commits via session.rename, cmd+r from the terminal, Escape cancels", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").dblclick();
  const input = page.getByTestId("rename-input");
  await expect(input).toBeFocused();
  await input.fill("Resize race, take two");
  await page.keyboard.press("Enter");
  await expect(row(page, "s:s-3").getByTestId("session-name")).toHaveText("Resize race, take two");
  const last = (await invocations()).at(-1);
  expect(last).toMatchObject({ name: "session.rename", args: { name: "Resize race, take two" } });
  expect(last?.context?.activeSessionId).toBe("s-3");

  await row(page, "s:s-1").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  const before = (await invocations()).length;
  await page.keyboard.press("Meta+r");
  await expect(row(page, "s:s-1").getByTestId("rename-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rename-input")).toHaveCount(0);
  expect((await invocations()).length).toBe(before);
});

test("FocusTerminal on a session's terminal selects the session", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => emit({ focusTerminal: { terminalId: "t-ghostty" } })).toBeGreaterThan(0);
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-ghostty");
});

test("FocusSession intent selects the session", async ({ page }) => {
  // TODO(phase2a merge): runs once ui.proto has FocusSession and `make gen` has run.
  test.skip(!hasFocusSession, "UiIntent.FocusSession is added to ui.proto by Phase 2a");
  await openApp(page);
  await expect.poll(async () => ((await mockPost("session/focus?id=s-3")) as { delivered: number }).delivered).toBeGreaterThan(0);
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("session-disconnected")).toBeVisible();
});

test("the whole app runs on one events stream plus one Attach", async ({ page }) => {
  const started = new Map<string, number>();
  const open = new Map<string, number>();
  const name = (r: Request) => /codefoundry\.v1\.(\w+\/\w+)$/.exec(new URL(r.url()).pathname)?.[1] ?? "";
  const done = (r: Request) => {
    const n = name(r);
    if (n) open.set(n, (open.get(n) ?? 1) - 1);
  };
  page.on("request", (r) => {
    const n = name(r);
    if (!n || r.method() !== "POST") return;
    started.set(n, (started.get(n) ?? 0) + 1);
    open.set(n, (open.get(n) ?? 0) + 1);
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);

  await openApp(page);
  // Exercise every source: sessions, terminals (switching attaches), intents, repos.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await row(page, "t:t-logs").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-logs");
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-ghostty");
  await mockPost("session/attention?id=s-1");
  await expect(page.getByTestId("attention-badge")).toHaveText("2");
  await expect.poll(() => emit({ notify: { title: "ping" } })).toBeGreaterThan(0);
  await expect(page.getByText("ping")).toBeVisible();

  // Client side (network entries): exactly one EventService.Watch was ever opened, no
  // per-service Watch at all, and only the visible terminal's Attach is still open.
  expect(started.get("EventService/Watch")).toBe(1);
  for (const legacy of ["RepoService/Watch", "TerminalService/Watch", "UiService/WatchIntents", "SessionService/Watch", "GhService/Watch"]) {
    expect(started.get(legacy) ?? 0, legacy).toBe(0);
  }
  await expect.poll(() => open.get("EventService/Watch")).toBe(1);
  await expect.poll(() => open.get("TerminalService/Attach")).toBe(1);
  expect(started.get("TerminalService/Attach")).toBe(3);
  // Server side agrees.
  await expect.poll(openStreams).toEqual({ "EventService/Watch": 1, "TerminalService/Attach": 1 });
});

test("a daemon without SessionService degrades to 'service unavailable'", async ({ page }) => {
  await mockPost("sessions-service?enabled=false");
  await openApp(page);
  await expect(page.getByTestId("sessions-unavailable")).toHaveText("Sessions: service unavailable");
  // Repos and terminals still work; session terminals show as plain terminals.
  await expect(row(page, "t:t-claude")).toBeVisible();
  await expect(page.locator('[data-row-kind="session"]')).toHaveCount(0);
  await row(page, "t:t-claude").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await expect(page.getByTestId("daemon-status")).not.toContainText("syncing");
});
