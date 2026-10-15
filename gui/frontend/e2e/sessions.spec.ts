import { expect, test, type Page, type Request } from "@playwright/test";
import { appPath, CF, emit, invocations, mockPost, openApp, openProjects, openStreams, releaseSessions, resetMock, row } from "./fixtures";

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
  // Only threads have rows (and the Working, Snoozed and Archived headers): their terminals show
  // through them, shells in bottom panels.
  const keys = await tree.locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(keys.every((k) => k?.startsWith("s:") || k === "h:working" || k === "h:snoozed" || k === "h:archived")).toBe(true);
  // Disconnected rows are dimmed as a whole (not just the name); starting settles into connected on the mock's timer.
  await expect(row(page, "s:s-3").getByTestId("session-body")).toHaveAttribute("data-offline", "true");
  await expect(row(page, "s:s-3").getByTestId("session-body")).toHaveCSS("opacity", "0.5");
  await expect(row(page, "s:s-3").getByTestId("session-name")).not.toHaveClass(/text-muted-foreground/);
  await expect(row(page, "s:s-1").getByTestId("session-body")).not.toHaveAttribute("data-offline");
  // resetMock holds s-5 starting; released, the mock's clock settles it.
  await releaseSessions("s-5");
  await expect(badge(page, "s-5")).toHaveAttribute("data-session-badge", /^(idle|busy)$/, { timeout: 12_000 });
  await expect(row(page, "s:s-5")).toHaveAttribute("data-section", "idle");
});

test("a disconnected thread shows its conversation and the Reconnect card; Reconnect starts it again", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-4").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Investigate the flaky e2e run on CI.");
  const card = page.getByTestId("thread-disconnected");
  await expect(card).toHaveText(/Not connected · crashed \(exit code 139\)\. Reconnect to continue the conversation\./);
  await expect(page.getByTestId("thread-composer")).toHaveCount(0);
  await expect(card.getByTestId("reconnect")).toBeFocused();

  await card.getByTestId("reconnect").click();
  await expect(page.getByTestId("session-indicator")).toHaveText("starting…");
  await expect(page.getByTestId("thread-composer")).toBeVisible();
  // The prompt takes the keyboard back from the Reconnect button.
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("session-indicator")).toHaveCount(0, { timeout: 8000 });
  await expect(badge(page, "s-4")).toHaveAttribute("data-session-badge", "idle");
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("session.reconnect");
  expect(last?.context).toMatchObject({ activeSessionId: "s-4", activeView: "session" });
});

test("a live thread that disconnects swaps its composer for the Reconnect card, and Enter reconnects", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const composer = page.getByTestId("thread-composer");
  await expect(composer.getByTestId("composer-input")).toBeFocused();

  await mockPost("session/disconnect?id=s-1&reason=exited&code=0&status=idle");
  const card = page.getByTestId("thread-disconnected");
  await expect(card).toContainText("Not connected · Claude exited.");
  await expect(badge(page, "s-1")).toHaveAttribute("data-session-badge", "disconnected");
  // The conversation stays.
  await expect(page.getByTestId("thread-pane").getByTestId("thread-user").first()).toContainText("Refactor the sidebar tree");

  // Enter on the focused Reconnect button (keyboard path).
  await expect(card.getByTestId("reconnect")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(composer.getByTestId("composer-input")).toBeFocused();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.reconnect");
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
  await expect(row(page, "s:s-2").getByTestId("row-status")).toHaveText("Needs input · Bash zig build -Doptimize=ReleaseFast");
  await expect(row(page, "s:s-2").getByTestId("session-body")).toHaveAttribute("data-offline", "true");
});

test("the Reconnect card says why the thread stopped; the header still says where it ran", async ({ page }) => {
  await openApp(page);
  const card = page.getByTestId("thread-disconnected");

  // s-1 crashes mid-turn.
  await mockPost("session/disconnect?id=s-1&reason=crashed&code=1&status=busy");
  await row(page, "s:s-1").click();
  await expect(card).toContainText("Not connected · crashed (exit code 1).");
  await expect(page.getByTestId("thread-title")).toHaveText("Refactor sidebar tree");

  // s-2 was asking for permission when the daemon stopped.
  await mockPost("session/disconnect?id=s-2&reason=daemon%20stopped&code=0");
  await row(page, "s:s-2").click();
  await expect(card).toContainText("Not connected · daemon stopped.");

  // s-3 is seeded after Claude exited, in the fix/resize worktree.
  await row(page, "s:s-3").click();
  await expect(card).toContainText("Not connected · Claude exited.");
  // The header says where it runs (project @ branch, a linked worktree), not the path, model or status.
  await expect(page.getByTestId("thread-location")).toHaveText("code-foundry@fix/resizeworktree");
  await expect(page.getByTestId("thread-worktree-chip")).toBeVisible();
  await expect(page.getByTestId("thread-header")).not.toContainText("Opus");
  await expect(page.getByTestId("thread-header")).not.toContainText("fix-resize");
  await expect(page.getByTestId("thread-header")).not.toContainText("disconnected");
});

test("close shows closing… then the Reconnect card with the reason", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("Meta+Shift+w"); // session.close, from the focused prompt
  await expect(page.getByTestId("session-indicator")).toHaveText("closing…");
  await expect(page.getByTestId("thread-disconnected")).toContainText("Not connected · closed.", { timeout: 8000 });
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
  await page.keyboard.press("Meta+Shift+a"); // from inside the focused prompt
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
  await count.click();
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");

  // Answering the waiting thread's docked permission (1: allow, the prompt being empty) clears it.
  await expect(page.getByTestId("thread-permission")).toBeVisible();
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("1");
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
  await expect(page.getByTestId("composer-worktree")).toHaveText("fix/resize");
  // No base ref for an existing worktree.
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("Fix the resize race");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const last = (await invocations()).at(-1);
  expect(last?.args).toEqual({ repo: "repo-cf", worktree: FIX_RESIZE, model: "claude-opus-4-8[1m]", effort: "high", permission: "auto", prompt: "Fix the resize race" });
  // The thread is the newest row, in that worktree, selected and shown.
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  await expect(created.getByTestId("row-branch")).toHaveText("fix/resize");
  const key = await created.getAttribute("data-row-key");
  // Starting, it sits under Working; once idle it is the newest idle thread: first in its
  // group, right below the waiting ones.
  const firstIdle = () =>
    page
      .getByTestId("thread-list")
      .locator('[data-row-key][data-section="idle"]')
      .evaluateAll((els) => els[0]?.getAttribute("data-row-key"));
  await expect.poll(firstIdle).toBe(key);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", (key ?? "").slice(2));
});

test("rename inline: double-click commits via session.rename, cmd+r from the prompt, Escape cancels", async ({ page }) => {
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
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  const before = (await invocations()).length;
  await page.keyboard.press("Meta+r");
  await expect(row(page, "s:s-1").getByTestId("rename-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rename-input")).toHaveCount(0);
  expect((await invocations()).length).toBe(before);
});

test("FocusSession intent selects the session", async ({ page }) => {
  await openApp(page);
  await expect.poll(async () => ((await mockPost("session/focus?id=s-3")) as { delivered: number }).delivered).toBeGreaterThan(0);
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("thread-disconnected")).toBeVisible();
  await expect(page.getByTestId("reconnect")).toBeFocused();
});

test("the whole app runs on one events stream plus one thread Watch", async ({ page }) => {
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
  // Exercise every source: sessions, threads (switching watches the other one), intents, repos.
  const pane = page.getByTestId("thread-pane");
  await row(page, "s:s-2").click();
  await expect(pane.getByTestId("thread-user").first()).toContainText("Port the grid renderer");
  await row(page, "s:s-1").click();
  await expect(pane.getByTestId("thread-user").first()).toContainText("Refactor the sidebar tree");
  await row(page, "s:s-2").click();
  await expect(pane.getByTestId("thread-user").first()).toContainText("Port the grid renderer");
  await mockPost("session/attention?id=s-1");
  await expect(page.getByTestId("attention-badge")).toHaveText("2");
  await expect.poll(() => emit({ notify: { title: "ping" } })).toBeGreaterThan(0);
  await expect(page.getByText("ping")).toBeVisible();

  // Client side (network entries): exactly one EventService.Watch was ever opened, no
  // per-service Watch at all, only the visible thread's Watch is still open, and no
  // terminal is attached (threads have none; the bottom panel is closed).
  expect(started.get("EventService/Watch")).toBe(1);
  for (const legacy of ["RepoService/Watch", "TerminalService/Watch", "UiService/WatchIntents", "SessionService/Watch", "GhService/Watch"]) {
    expect(started.get(legacy) ?? 0, legacy).toBe(0);
  }
  await expect.poll(() => open.get("EventService/Watch")).toBe(1);
  await expect.poll(() => open.get("ThreadService/Watch")).toBe(1);
  expect(started.get("ThreadService/Watch")).toBeGreaterThanOrEqual(3);
  expect(started.get("TerminalService/Attach") ?? 0).toBe(0);
  // Server side agrees.
  await expect.poll(openStreams).toEqual({ "EventService/Watch": 1, "ThreadService/Watch": 1 });
});

test("a daemon without SessionService degrades to 'service unavailable'", async ({ page }) => {
  await mockPost("sessions-service?enabled=false");
  // No rows to wait for (openApp waits for one): the notice is what shows.
  await page.goto(appPath);
  await expect(page.getByTestId("sessions-unavailable")).toHaveText("Threads: service unavailable");
  // No thread rows; repos still work (the Projects page, and its shells' bottom panel).
  await expect(page.locator('[data-row-kind="session"]')).toHaveCount(0);
  await expect(page.getByTestId("daemon-status")).not.toContainText("syncing");
  await openProjects(page);
  await expect(page.getByTestId("project-name").first()).toBeVisible();
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-terminal-id", "t-top");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-attach-phase", "live");
});
