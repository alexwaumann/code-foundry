import { expect, test, type Page, type Request } from "@playwright/test";
import { CF, emit, invocations, mockPost, openApp, openProjects, openStreams, resetMock, row } from "./fixtures";

const FIX_RESIZE = `${CF}.worktrees/fix-resize`;

test.beforeEach(async () => {
  await resetMock();
});

function badge(page: Page, sessionId: string) {
  return row(page, `s:${sessionId}`).locator("[data-session-badge]");
}

test("session rows render with status badges, above the terminals no thread owns", async ({ page }) => {
  await openApp(page);
  const tree = page.getByTestId("thread-list");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", /^(busy|idle)$/);
  await expect(badge(page, "s-2")).toHaveAttribute("data-session-badge", "attention");
  await expect(badge(page, "s-3")).toHaveAttribute("data-session-badge", "disconnected");
  await expect(badge(page, "s-4")).toHaveAttribute("data-session-badge", "disconnected");
  await expect(badge(page, "s-5")).toHaveAttribute("data-session-badge", "starting");
  await expect(badge(page, "s-6")).toHaveAttribute("data-session-badge", "closing");
  // Session-owned terminals have no row of their own.
  await expect(row(page, "t:t-claude")).toHaveCount(0);
  await expect(row(page, "t:t-ghostty")).toHaveCount(0);
  // Threads come before plain terminals.
  const keys = await tree.locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(keys.indexOf("s:s-4")).toBeLessThan(keys.indexOf("t:t-top"));
  expect(keys.indexOf("s:s-5")).toBeLessThan(keys.indexOf("t:t-top"));
  // Disconnected rows are dimmed as a whole (not just the name); starting settles into connected on the mock's timer.
  await expect(row(page, "s:s-3").getByTestId("session-body")).toHaveAttribute("data-offline", "true");
  await expect(row(page, "s:s-3").getByTestId("session-body")).toHaveCSS("opacity", "0.5");
  await expect(row(page, "s:s-3").getByTestId("session-name")).not.toHaveClass(/text-muted-foreground/);
  await expect(row(page, "s:s-1").getByTestId("session-body")).not.toHaveAttribute("data-offline");
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

  await mockPost("session/disconnect?id=s-1&reason=exited&code=0&status=idle");
  await expect(page.getByTestId("disconnect-reason")).toHaveText("Claude exited");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", "disconnected");

  // Enter on the focused Reconnect button (keyboard path).
  await expect(page.getByTestId("reconnect")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(host).toHaveAttribute("data-terminal-id", /^t-s-1-/);
  await expect(host).toHaveAttribute("data-attach-phase", "live");
});

test("a disconnected thread keeps its status: busy ends interrupted, attention persists", async ({ page }) => {
  await openApp(page);
  await mockPost("session/disconnect?id=s-1&reason=crashed&code=1&status=busy");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", "error");
  await expect(row(page, "s:s-1").getByTestId("row-status")).toHaveText("Interrupted while working · just now");
  await mockPost("session/disconnect?id=s-2&reason=daemon%20stopped&code=0");
  await expect(badge(page, "s-2")).toHaveAttribute("data-session-badge", "attention");
  // Still waiting on the user: counted, still on top, still saying so (dimmed).
  await expect(page.getByTestId("attention-badge")).toHaveText("1");
  await expect.poll(async () => (await page.getByTestId("thread-list").locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")))).slice(0, 1)).toEqual(["s:s-2"]);
  await expect(row(page, "s:s-2").getByTestId("row-status")).toHaveText("Needs input · Do you want to proceed?");
  await expect(row(page, "s:s-2").getByTestId("session-body")).toHaveAttribute("data-offline", "true");
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

  // Both sit on top, newest first: s-2 (40 min old) before s-1 (42 min); wraps around.
  await expect.poll(async () => (await page.getByTestId("thread-list").locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")))).slice(0, 2)).toEqual(["s:s-2", "s:s-1"]);
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a"); // from inside the focused terminal
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
  await count.click();
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");

  // Typing into a session that needed attention clears it (mock: input -> busy).
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.type("y");
  await expect(count).toHaveText("1");
  await expect(page).toHaveTitle("Code Foundry (1)");
});

test("new thread: a worktree's + on the Projects page opens the composer with that worktree", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const wt = page.locator(`[data-nav-key="pw:repo-cf::${FIX_RESIZE}"]`);
  await wt.hover();
  await wt.getByTestId("worktree-new-thread").click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  await expect(page.getByTestId("composer-worktree")).toHaveText("Existing worktree: fix/resize");
  // No base ref for an existing worktree.
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("Fix the resize race");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const last = (await invocations()).at(-1);
  expect(last?.args).toEqual({ repo: "repo-cf", worktree: FIX_RESIZE, model: "opus", effort: "high", permission: "auto", prompt: "Fix the resize race" });
  // The thread is the newest row, in that worktree, selected and attached.
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  await expect(created.getByTestId("row-branch")).toHaveText("fix/resize");
  const key = await created.getAttribute("data-row-key");
  const sections = await page.getByTestId("thread-list").locator("[data-row-key]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-row-key"), e.getAttribute("data-section")]));
  // The newest thread that needs nothing: first in its group, right below the waiting ones.
  expect(sections.find(([, section]) => section === "threads")?.[0]).toBe(key);
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
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
  await expect(page.getByTestId("sessions-unavailable")).toHaveText("Threads: service unavailable");
  // Repos and terminals still work; session terminals show as plain terminals.
  await expect(row(page, "t:t-claude")).toBeVisible();
  await expect(page.locator('[data-row-kind="session"]')).toHaveCount(0);
  await row(page, "t:t-claude").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await expect(page.getByTestId("daemon-status")).not.toContainText("syncing");
});
