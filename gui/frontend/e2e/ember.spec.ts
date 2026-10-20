import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, openStreams, resetMock } from "./fixtures";

/**
 * Ember in the GUI (docs/notes/ember-3-gui.md) over the mock's Ember (mock/ember.ts, its
 * chat mock/emberChat.ts): the pinned row above New thread while ember.enabled is on, the
 * chat with its "Worked for" rows and task links, the Board panel, and the worker-model
 * chips. Ember is off after a reset; POST /__mock/ember?enabled=true turns it on. The
 * board's "Validate notes API input" task is a lead (s-ember-lead, waiting on its team)
 * with three workers below it (docs/notes/ember-fixes-1-gui.md).
 */

const emberRow = (page: Page) => page.getByTestId("sidebar-ember");
const pane = (page: Page) => page.getByTestId("ember-pane");
const board = (page: Page) => page.getByTestId("ember-board");

async function enable(): Promise<void> {
  await mockPost("ember?enabled=true");
}

async function openChat(page: Page): Promise<void> {
  await emberRow(page).click();
  await expect(pane(page)).toBeVisible();
  await expect(pane(page).getByTestId("ember-text").first()).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("the row shows only while Ember is on, above New thread", async ({ page }) => {
  await openApp(page);
  await expect(emberRow(page)).toHaveCount(0);
  await enable();
  await expect(emberRow(page)).toBeVisible();
  // Directly under the toolbar, above New thread.
  const rowBox = await emberRow(page).boundingBox();
  const newBox = await page.getByTestId("sidebar-new-thread").boundingBox();
  expect(rowBox && newBox && rowBox.y < newBox.y).toBe(true);
  // "<Status> · <first doing task> · N threads"; the flame works while a task is doing.
  await expect(emberRow(page).getByTestId("ember-row-status")).toHaveText("Working");
  await expect(emberRow(page).getByTestId("ember-row-task")).toHaveText("Add release notes for 0.20");
  // The notes worker, the lead (waiting on its team) and the team's two working threads.
  await expect(emberRow(page).getByTestId("ember-row-threads")).toHaveText("4 threads");
  await expect(emberRow(page)).toHaveAttribute("data-flame", "working");
  // The thread list never lists Ember itself.
  await expect(page.getByTestId("thread-list").locator('[data-row-key="s:s-resident-ember"]')).toHaveCount(0);
  await mockPost("ember?enabled=false");
  await expect(emberRow(page)).toHaveCount(0);
});

test("the row opens the chat; its menu has no archive, snooze or rename", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  await expect(emberRow(page)).toHaveAttribute("aria-selected", "true");
  const header = page.getByTestId("thread-header");
  await expect(header.getByTestId("ember-title")).toHaveText("Ember");
  await expect(header.getByTestId("ember-header-status")).toHaveText("4 threads working · 1 queued");
  await expect(header.getByTestId("ember-board-toggle")).toBeVisible();
  await expect(header.locator('[data-command-button="thread.archive"]')).toHaveCount(0);
  await expect(page.getByTestId("thread-composer").locator("[aria-placeholder]")).toHaveAttribute("aria-placeholder", "Tell Ember what you want done…");
  await emberRow(page).click({ button: "right" });
  const menu = page.getByTestId("ember-row-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Open board", "Settings"]);
  await page.keyboard.press("Escape");
});

test("arrows reach the row from the thread list", async ({ page }) => {
  await enable();
  await openApp(page);
  const list = page.getByTestId("thread-list");
  await list.focus();
  await page.keyboard.press("Home");
  await expect(emberRow(page)).toHaveAttribute("data-cursor", "true");
  await page.keyboard.press("Enter");
  await expect(pane(page)).toBeVisible();
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list.locator("[data-cursor]").first()).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(emberRow(page)).toHaveAttribute("data-cursor", "true");
});

test("work folds into Worked for rows; one opens in place, Show work opens all", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const work = pane(page).getByTestId("ember-work");
  await expect(work).toHaveCount(3);
  await expect(work.nth(0)).toContainText("Worked for 1m");
  await expect(work.nth(0).getByTestId("ember-work-summary")).toHaveText("read 2 files, created 2 threads, updated the board");
  await expect(work.nth(1).getByTestId("ember-work-summary")).toHaveText("1 wake, read 1 thread, checked the board");
  // Folded: no tool rows, no wake note.
  await expect(pane(page).getByTestId("thread-tool")).toHaveCount(0);
  await expect(pane(page).getByTestId("thread-wake-note")).toHaveCount(0);
  // One opens in place.
  await work.nth(1).getByRole("button").click();
  await expect(work.nth(1)).toHaveAttribute("data-expanded", "true");
  await expect(pane(page).getByTestId("thread-wake-note")).toHaveCount(1);
  await expect(work.nth(0)).not.toHaveAttribute("data-expanded", "true");
  // Show work opens every one, and stays on (the UI store).
  await page.getByTestId("ember-show-work").click();
  await expect(page.getByTestId("ember-show-work")).toHaveAttribute("aria-pressed", "true");
  for (let i = 0; i < 3; i++) await expect(work.nth(i)).toHaveAttribute("data-expanded", "true");
  await page.getByTestId("ember-show-work").click();
  for (let i = 0; i < 3; i++) await expect(work.nth(i)).not.toHaveAttribute("data-expanded", "true");
});

test("a task link is a pointer line that opens the board at its task", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const link = pane(page).locator('[data-testid="ember-task-link"][data-task="t-9c0d1e2f"]').first();
  await expect(link).toContainText("Bump wails to v3.1");
  await expect(link.getByTestId("ember-task-link-meta")).toHaveText("· blocked");
  // No raw markdown link left.
  await expect(pane(page).getByText("cf-task://")).toHaveCount(0);
  await link.click();
  await expect(board(page)).toBeVisible();
  await expect(page.getByTestId("ember-board-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(board(page).locator('[data-testid="ember-task"][data-task="t-9c0d1e2f"]')).toHaveAttribute("data-focused", "true");
  // The meta follows the board live.
  await mockPost("ember/task?id=t-9c0d1e2f&state=done&outcome=Pinned");
  await expect(link.getByTestId("ember-task-link-meta")).toHaveText("· done");
});

test("the board's sections, cards and worker rows; one board stream", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  await page.getByTestId("ember-board-toggle").click();
  await expect(board(page).getByTestId("ember-board-counts")).toHaveText("3 in progress · 0 up next");
  const ids = (section: string) => board(page).getByTestId(`ember-section-${section}`).getByTestId("ember-task").evaluateAll((els) => els.map((e) => e.getAttribute("data-task")));
  expect(await ids("in-progress")).toEqual(["t-1a2b3c4d", "t-9c0d1e2f", "t-4c5d6e7f"]);
  expect(await ids("done-today")).toEqual(["t-3a4b5c6d", "t-7e8f9a0b"]);
  await expect(board(page).getByTestId("ember-section-up-next")).toHaveCount(0);
  const notes = board(page).locator('[data-testid="ember-task"][data-task="t-1a2b3c4d"]');
  await expect(notes.getByTestId("ember-task-meta")).toHaveText("0 of 1");
  await expect(notes.getByTestId("ember-task-progress")).toBeVisible();
  await expect(notes.getByTestId("ember-worker")).toHaveCount(2);
  const blocked = board(page).locator('[data-testid="ember-task"][data-task="t-9c0d1e2f"]');
  await expect(blocked.getByTestId("ember-task-outcome")).toHaveText("wails v3.1 needs Go 1.27; the toolchain here is 1.26");
  // The sidebar row, the chat and the panel share one WatchBoard.
  expect((await openStreams())["EmberService/WatchBoard"]).toBe(1);
  // A new todo task lands in Up next, live.
  await mockPost(`ember/task/add?title=${encodeURIComponent("Same for thread read")}`);
  await expect(board(page).getByTestId("ember-board-counts")).toHaveText("3 in progress · 1 up next");
  // A worker row opens its thread (a hidden child of Ember's).
  await notes.locator('[data-testid="ember-worker"][data-thread="s-ember-notes"]').click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ember-notes");
});

test("a lead's team: worker rows under its card, counted as working", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  await page.getByTestId("ember-board-toggle").click();
  const lead = board(page).locator('[data-testid="ember-task"][data-task="t-4c5d6e7f"]');
  // The lead waits on its team: Working, not Idle.
  await expect(lead.getByTestId("ember-task-meta")).toHaveText("Working");
  const workers = lead.getByTestId("ember-worker");
  await expect(workers).toHaveCount(4);
  await expect(workers.nth(0)).toHaveAttribute("data-thread", "s-ember-lead");
  await expect(workers.nth(0)).not.toHaveAttribute("data-team", "true");
  const team = lead.locator('[data-testid="ember-worker"][data-team]');
  await expect(team).toHaveCount(3);
  expect(await team.evaluateAll((els) => els.map((e) => e.getAttribute("data-thread")))).toEqual(["s-ember-team-schema", "s-ember-team-post", "s-ember-team-put"]);
  await expect(team.nth(0).getByTestId("ember-worker-meta")).toHaveText("Schema in internal/api/notes_schema.go");
  await expect(team.nth(1).getByTestId("ember-worker-meta")).toHaveText("Working");
  await expect(team.nth(1).locator("[data-dot]")).toHaveAttribute("data-dot", "doing");
  // A team member finishing leaves the header and the row, live.
  await mockPost(`thread/status?id=s-ember-team-post&status=attention&reason=finished`);
  await expect(page.getByTestId("ember-header-status")).toHaveText("3 threads working · 1 queued");
  await expect(emberRow(page).getByTestId("ember-row-threads")).toHaveText("3 threads");
  await expect(team.nth(1).getByTestId("ember-worker-meta")).toHaveText("Finished");
  // A team row opens its thread.
  await team.nth(2).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ember-team-put");
});

test("a worker waiting on the user: Needs input on the row, Ember in the bell until it is answered", async ({ page }) => {
  await enable();
  await openApp(page);
  const bell = page.getByTestId("sidebar-notifications");
  const status = emberRow(page).getByTestId("ember-row-status");
  await expect(status).toHaveText("Working");
  await expect(bell).toHaveAttribute("data-count", "1");
  // A lead's worker asks a question.
  await mockPost(`thread/status?id=s-ember-team-put&status=attention&reason=${encodeURIComponent("question: 404 or 422 for a bad id?")}`);
  await expect(status).toHaveText("Needs input");
  await expect(status).toHaveClass(/text-warning/);
  await expect(emberRow(page)).toHaveAttribute("data-flame", "attention");
  await expect(bell).toHaveAttribute("data-count", "2");
  if (process.env.SHOTS) await page.getByTestId("sidebar-body").screenshot({ path: `${process.env.SHOTS}/ember-row-needs-input.png` });
  // The bell goes to Ember (its row is the first that needs the user).
  await bell.click();
  await expect(pane(page)).toBeVisible();
  // Opening the chat does not clear it: only an answer does.
  await expect(status).toHaveText("Needs input");
  await expect(bell).toHaveAttribute("data-count", "2");
  await page.getByTestId("ember-board-toggle").click();
  await expect(board(page).locator('[data-testid="ember-worker"][data-thread="s-ember-team-put"]').getByTestId("ember-worker-meta")).toHaveText("Needs input");
  // A task's own worker asking counts too, once with the team's.
  await mockPost(`thread/status?id=s-ember-notes&status=attention&reason=${encodeURIComponent("permission: Bash git push")}`);
  await expect(bell).toHaveAttribute("data-count", "2");
  await mockPost("thread/status?id=s-ember-notes&status=busy");
  await mockPost("thread/status?id=s-ember-team-put&status=busy");
  await expect(status).toHaveText("Working");
  await expect(emberRow(page)).toHaveAttribute("data-flame", "working");
  await expect(bell).toHaveAttribute("data-count", "1");
});

test("paths in Ember's chat: an absolute one under a project is a chip; relative ones and git ranges stay code", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const last = pane(page).getByTestId("ember-text").last();
  await expect(last).toContainText("The notes API team is under way");
  // Three work rows still: the lead's progress wake Ember only thought about draws none.
  await expect(pane(page).getByTestId("ember-work")).toHaveCount(3);
  await expect(last.getByTestId("path-chip")).toHaveCount(1);
  await expect(last.getByTestId("path-plain")).toHaveText(["README.md"]);
  await expect(last.locator("code", { hasText: "main..cf/notes-validation" })).toHaveCount(1);
  await last.getByTestId("path-chip").click();
  await expect(page.getByTestId("file-tab")).toHaveAttribute("data-path", "/Users/dev/src/code-foundry/README.md");
});

test("the board is not offered off Ember's chat", async ({ page }) => {
  await enable();
  await openApp(page);
  await page.getByTestId("thread-list").locator('[data-row-key="s:s-2"]').click();
  await page.getByTestId("panel-toggle").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
  // The surface list (the empty panel) lists others, never the Board.
  await expect(page.getByTestId("side-panel").locator('[data-surface="files"]')).toBeVisible();
  await expect(page.getByTestId("side-panel").locator('[data-surface="ember"]')).toHaveCount(0);
});

test("settings: the flame in the nav, worker models as chips", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-nav-ember").click();
  await expect(page.getByTestId("settings-nav-ember").getByTestId("ember-flame")).toBeVisible();
  const chips = page.getByTestId("ember-worker-models");
  const chip = (model: string) => chips.locator(`[data-model="${model}"]`);
  await expect(chip("claude-opus-4-7[1m]")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("claude-opus-4-8[1m]")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("claude-sonnet-5[1m]")).toHaveAttribute("aria-pressed", "false");
  await expect(chip("claude-sonnet-5[1m]")).toHaveText("Sonnet 5");
  const value = async () => {
    const res = await fetch(`${mockUrl}/__mock/settings`);
    return ((await res.json()) as { values: Record<string, string> }).values["ember.worker_models"];
  };
  await chip("claude-sonnet-5[1m]").click();
  await expect(chip("claude-sonnet-5[1m]")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(value).toBe("claude-opus-4-7[1m],claude-opus-4-8[1m],claude-sonnet-5[1m]");
  await chip("claude-opus-4-7[1m]").click();
  await chip("claude-opus-4-8[1m]").click();
  await expect.poll(value).toBe("claude-sonnet-5[1m]");
  // The last one stays: it cannot be released.
  await expect(chip("claude-sonnet-5[1m]")).toHaveAttribute("aria-disabled", "true");
  await chip("claude-sonnet-5[1m]").click({ force: true });
  await expect(chip("claude-sonnet-5[1m]")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(value).toBe("claude-sonnet-5[1m]");
});
