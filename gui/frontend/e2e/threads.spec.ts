import { expect, test, type Page, type Request } from "@playwright/test";
import { BACKGROUND, CF, emit, expectAttention, invocations, mockPost, openApp, openProjectPage, openStreams, resetMock, row } from "./fixtures";
import { paletteRun } from "./shell";
import { openRowThread } from "./shell-threads";

const FIX_RESIZE = `${CF}.worktrees/fix-resize`;

test.beforeEach(async () => {
  await resetMock();
});

function badge(page: Page, threadId: string) {
  return row(page, `s:${threadId}`).locator("[data-thread-badge]");
}

// Rows' badges (stopped reads idle, starting working), only thread rows and the footers' headers, no
// offline mark or lifecycle words: src/components/sidebar/Sidebar.test.tsx ("each row carries its badge…");
// the badge rules: src/lib/thread.test.ts.

test("a stopped thread shows its conversation and the composer; a message starts it and gets the answer", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-4").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Investigate the flaky e2e run on CI.");
  await expect(page.getByTestId("thread-disconnected")).toHaveCount(0);
  await expect(page.getByTestId("reconnect")).toHaveCount(0);
  await expect(pane).not.toContainText(/Not connected|Reconnect|starting…|closing…/);
  const composer = page.getByTestId("thread-composer");
  await expect(composer.getByTestId("composer-input")).toBeFocused();

  await page.keyboard.type("Is it still flaky?");
  await expect(composer.getByTestId("thread-send")).toBeEnabled();
  await page.keyboard.press("Enter");
  // The message is in at once; while Claude starts it looks like any working thread.
  await expect(pane.getByTestId("thread-user").last()).toContainText("Is it still flaky?");
  await expect(pane.getByTestId("thread-working")).toContainText("Working");
  await expect(pane).not.toContainText(/Starting Claude|starting…/);
  await expect(badge(page, "s-4")).toHaveAttribute("data-thread-badge", "busy");
  await expect(pane.locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.", { timeout: 10_000 });
  await expect(composer.getByTestId("composer-input")).toBeFocused();
});

test("a running thread that stops looks the same: the composer stays focused and still sends", async ({ page }) => {
  // The scripted thread, running and idle at its prompt (both turns done).
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  const composer = page.getByTestId("thread-composer");
  await expect(composer.getByTestId("composer-input")).toBeFocused();
  const firstUser = page.getByTestId("thread-pane").getByTestId("thread-user").first();
  await expect(firstUser).toBeVisible();
  const firstText = (await firstUser.textContent()) ?? "";

  // The daemon's idle stop at cache expiry.
  await mockPost("thread/stop?id=s-r1&reason=idle&code=0&status=idle");
  await expect(badge(page, "s-r1")).toHaveAttribute("data-thread-badge", "idle");
  await expect(page.getByTestId("thread-disconnected")).toHaveCount(0);
  await expect(composer.getByTestId("composer-input")).toBeFocused();
  // The conversation stays.
  await expect(firstUser).toHaveText(firstText);

  await page.keyboard.type("Carry on");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-pane").getByTestId("thread-user").last()).toContainText("Carry on");
  await expect(page.getByTestId("thread-pane").locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.", { timeout: 10_000 });
});

// A stopped thread keeping its status (busy ends Interrupted with "resend to continue"; a prompt stays
// waiting on top with its word and detail): src/components/sidebar/Sidebar.test.tsx; counted in the
// title: src/stores/threads.test.ts (attentionIds); interrupting a busy thread on stop is the
// daemon's (internal/store/thread).

// A crashed or stopped thread's header (the project, no path, model or state):
// src/components/thread/ThreadHeaderStopped.test.tsx; ThreadPane renders the composer for every thread.

test("needs-attention: window title and cmd+shift+a", async ({ page }) => {
  await openApp(page);
  await expectAttention(page, 1);

  await mockPost("thread/attention?id=s-1");
  await expectAttention(page, 2);
  await expect(row(page, "s:s-1")).toHaveAttribute("data-section", "needs");

  // Both sit under Needs you, newest status change first: s-1 (asked just now) before s-2.
  // cmd+shift+a opens the next one's Needs-you popup (shell-model.md, Keys), wrapping around.
  const needs = () => page.locator('[data-section="needs"][data-row-kind="thread"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  await expect.poll(needs).toEqual(["s:s-1", "s:s-2"]);
  const popup = page.getByTestId("needs-popup");
  for (const id of ["s-1", "s-2", "s-1", "s-2"]) {
    await page.keyboard.press("Meta+Shift+a"); // after the first, from inside the popup
    await expect(popup).toHaveAttribute("data-thread-id", id);
  }

  // Answering the waiting thread's permission in its popup (1: allow) clears it.
  await expect(popup.getByTestId("thread-permission")).toBeFocused();
  await page.keyboard.press("1");
  await expectAttention(page, 1);
});

test("new thread: a checkout's New thread here on its project page opens the composer with that worktree", async ({ page }) => {
  await openApp(page);
  // The window opens on an empty space: the palette opens the Projects page as its tab.
  await paletteRun(page, "Show Projects", "view.projects");
  await openProjectPage(page, "repo-cf");
  const wt = page.locator(`[data-nav-key="pw:repo-cf::${FIX_RESIZE}"]`);
  await wt.click({ button: "right" });
  await page.getByTestId("checkout-menu-new-thread").click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  await expect(page.getByTestId("composer-worktree")).toHaveText("fix/resize");
  // No base ref for an existing worktree.
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("Fix the resize race");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  const last = (await invocations()).at(-1);
  // compose: the window shell's composer tab, which becomes the thread's tab.
  expect(last?.args).toEqual({ ...BACKGROUND, project: "repo-cf", worktree: FIX_RESIZE, model: "claude-sonnet-5[1m]", effort: "medium", permission: "auto", prompt: "Fix the resize race", compose: expect.any(String) as unknown as string });
  // The thread is the newest row, in that worktree, selected and shown.
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
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
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", (key ?? "").slice(2));
});

test("rename inline: double-click commits via thread.rename, cmd+r from the prompt, Escape cancels", async ({ page }) => {
  await openApp(page);
  // Open it first: opening can move the row within its band, which would leave a
  // double click's second press on another row.
  await row(page, "s:s-3").click();
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  await row(page, "s:s-3").dblclick();
  const input = page.getByTestId("rename-input");
  await expect(input).toBeFocused();
  await input.fill("Resize race, take two");
  await page.keyboard.press("Enter");
  await expect(row(page, "s:s-3").getByTestId("thread-name")).toHaveText("Resize race, take two");
  const last = (await invocations()).at(-1);
  expect(last).toMatchObject({ name: "thread.rename", args: { name: "Resize race, take two" } });
  expect(last?.context?.activeThreadId).toBe("s-3");

  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  const before = (await invocations()).length;
  await page.keyboard.press("Meta+r");
  await expect(row(page, "s:s-1").getByTestId("rename-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rename-input")).toHaveCount(0);
  expect((await invocations()).length).toBe(before);
});

// Regenerate name from the row menu (thread.regenerate-name's args and context, the old name muted
// while it runs, then the new one): src/components/sidebar/Sidebar.test.tsx; the muted styles:
// src/components/sidebar/SidebarRow.test.tsx ("SidebarRow provisional name").

// The intent selecting the thread: src/stores/intents.test.ts; what is left is the prompt taking real focus.
test("FocusThread intent selects the thread", async ({ page }) => {
  await openApp(page);
  await expect.poll(async () => ((await mockPost("thread/focus?id=s-3")) as { delivered: number }).delivered).toBeGreaterThan(0);
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  // A stopped thread: the composer, as for any other.
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
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
  // The streams on the tunnel are sockets, which no request event shows.
  page.on("websocket", (ws) => {
    const n = /codefoundry\.v1\.(\w+\/\w+)$/.exec(ws.url())?.[1] ?? "";
    started.set(n, (started.get(n) ?? 0) + 1);
    open.set(n, (open.get(n) ?? 0) + 1);
    ws.on("close", () => {
      open.set(n, (open.get(n) ?? 1) - 1);
    });
  });

  await openApp(page);
  // Exercise every source: threads, threads (switching watches the other one), intents, projects.
  // Tabs of one pane: only the active one is drawn. s-2 waits on the user: its row's first line opens it.
  const pane = page.getByTestId("thread-pane");
  await openRowThread(page, "s-2");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Port the grid renderer");
  await row(page, "s:s-1").click();
  await expect(pane.getByTestId("thread-user").first()).toContainText("Refactor the sidebar tree");
  await openRowThread(page, "s-2");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Port the grid renderer");
  await mockPost("thread/attention?id=s-1");
  await expectAttention(page, 2);
  await expect.poll(() => emit({ notify: { title: "ping" } })).toBeGreaterThan(0);
  await expect(page.getByText("ping")).toBeVisible();

  // Client side (network entries): exactly one EventService.Watch was ever opened, no
  // per-service Watch at all, only the visible thread's Watch is still open, and no
  // terminal is attached (threads have none; the bottom panel is closed).
  expect(started.get("EventService/Watch")).toBe(1);
  for (const legacy of ["ProjectService/Watch", "UiService/WatchIntents"]) {
    expect(started.get(legacy) ?? 0, legacy).toBe(0);
  }
  await expect.poll(() => open.get("EventService/Watch")).toBe(1);
  await expect.poll(() => open.get("ThreadService/WatchThread")).toBe(1);
  expect(started.get("ThreadService/WatchThread")).toBeGreaterThanOrEqual(3);
  expect(started.get("TerminalService/Attach") ?? 0).toBe(0);
  // Server side agrees.
  await expect.poll(openStreams).toEqual({ "EventService/Watch": 1, "ThreadService/WatchThread": 1 });
});
