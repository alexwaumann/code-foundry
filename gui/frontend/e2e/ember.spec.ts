import { expect, test, type Locator, type Page } from "@playwright/test";
import { dragSelect, mockPost, openApp, openStreams, resetMock } from "./fixtures";

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
/** Ember's replies: the thread's text rows, final (a text folded into a run is not). */
const replies = (page: Page) => pane(page).locator('[data-testid="thread-text"][data-final]');

async function enable(): Promise<void> {
  await mockPost("ember?enabled=true");
}

/** Wheels the chat up until `target` is inside it (the list stays pinned to its bottom until the user scrolls). */
async function wheelTo(page: Page, target: Locator): Promise<void> {
  const box = await page.getByTestId("thread-timeline").boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + 200, box.y + 200);
  for (let i = 0; i < 40; i++) {
    const t = (await target.count()) > 0 ? await target.boundingBox() : null;
    if (t && t.y >= box.y && t.y + t.height <= box.y + box.height) return;
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(50);
  }
}

async function openChat(page: Page): Promise<void> {
  await emberRow(page).click();
  await expect(pane(page)).toBeVisible();
  await expect(replies(page).first()).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("the row shows only while Ember is on, under the menu pane and above the threads", async ({ page }) => {
  await openApp(page);
  await expect(emberRow(page)).toHaveCount(0);
  await enable();
  await expect(emberRow(page)).toBeVisible();
  // 8px under the menu pane, above the first thread row.
  const rowBox = await emberRow(page).boundingBox();
  const menuBox = await page.getByTestId("sidebar-menu").boundingBox();
  const firstBox = await page.locator('[data-testid="sidebar-main"] [role="option"]').first().boundingBox();
  expect(rowBox && menuBox && rowBox.y - (menuBox.y + menuBox.height)).toBe(8);
  expect(rowBox && firstBox && rowBox.y + rowBox.height <= firstBox.y).toBe(true);
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

// The row opening the chat (selected), the chat's header and prompt, and the row's menu: src/components/ember/EmberRow.test.tsx ("a click opens the chat…", "its menu: Open board and Settings only…") and EmberPane.test.tsx ("the flame and Ember, the board's summary…").

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
  await expect(work).toHaveCount(7);
  await expect(work.nth(0)).toContainText("Worked for 5s");
  // What each run did, in Ember's words (docs/notes/ember-fixes-2-gui.md): workers started,
  // what woke it, branches checked, tasks closed, a change sent, a timer.
  await expect(work.getByTestId("ember-work-summary")).toHaveText([
    "started 1 worker",
    "wake from Fix flaky TestSendSpawnFailure, closed 1 task, checked 1 branch",
    "read 2 files, started 2 workers, checked the board",
    "wake from Bump wails to v3.1, read 1 thread, checked the board",
    "sent a change to Release notes for 0.20, updated the board",
    // A wake Ember only thought about, then replied to, keeps its row (and its time).
    "wake from Lead: notes API input validation",
    "timer: check the notes draft",
  ]);
  // Every run shows when it ended.
  await expect(work.getByTestId("ember-work-time")).toHaveCount(7);
  await expect(work.nth(6).getByTestId("ember-work-time")).toHaveText(/\d/);
  // Folded: no tool rows, no wake note.
  await expect(pane(page).getByTestId("thread-tool")).toHaveCount(0);
  await expect(pane(page).getByTestId("thread-wake-note")).toHaveCount(0);
  // One opens in place.
  await wheelTo(page, work.nth(1));
  await work.nth(1).getByRole("button").click();
  await expect(work.nth(1)).toHaveAttribute("data-expanded", "true");
  await expect(pane(page).getByTestId("thread-wake-note")).toHaveCount(1);
  await expect(work.nth(0)).not.toHaveAttribute("data-expanded", "true");
  // Show work opens every one, and stays on (the UI store).
  await page.getByTestId("ember-show-work").click();
  await expect(page.getByTestId("ember-show-work")).toHaveAttribute("aria-pressed", "true");
  // Every row on screen (the open runs push the rest out of the virtualized list).
  const expanded = () => work.evaluateAll((els) => els.map((e) => e.hasAttribute("data-expanded")));
  await expect.poll(async () => (await expanded()).every(Boolean)).toBe(true);
  await page.getByTestId("ember-show-work").click();
  await expect.poll(async () => (await expanded()).some(Boolean)).toBe(false);
});

test("only a turn's last text is the reply; text between tool calls folds into the run", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const work = pane(page).getByTestId("ember-work");
  const note = pane(page).getByTestId("thread-text").filter({ hasText: "both can start now" });
  const reply = replies(page).filter({ hasText: "On it. Two pieces" });
  await wheelTo(page, reply);
  await expect(reply).toHaveCount(1);
  await expect(note).toHaveCount(0);
  // Its run opens to it, among the tool rows, not as a reply (no Copy answer).
  await wheelTo(page, work.nth(2));
  await work.nth(2).getByRole("button").click();
  await expect(note).toHaveCount(1);
  await expect(note).not.toHaveAttribute("data-final", "true");
  await expect(note.getByTestId("thread-copy-answer")).toHaveCount(0);
  await expect(reply.getByTestId("thread-copy-answer")).toHaveCount(1);
  // Its task links still are pointer lines (the thread's text row, Ember's markdown).
  await expect(reply.getByTestId("ember-task-link")).toHaveCount(2);
});

test("Ember's reply can be cited; Go to source opens the run a folded text is in", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const chips = page.getByTestId("thread-composer").locator('[data-testid="prompt-tag"][data-tag-kind="cite"]');
  const last = replies(page).last();
  await expect(last).toContainText("the worker is still drafting");
  await dragSelect(page, last, "the worker is still drafting");
  await page.getByTestId("cite-button").click();
  await expect(page.getByTestId("cite-comment")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chips).toHaveText(["the worker is still…"]);
  // A text folded into a run is citable once the run is open, and its chip opens the run again.
  const work = pane(page).getByTestId("ember-work");
  const run = work.nth(2);
  await wheelTo(page, run);
  await run.getByRole("button").click();
  const note = pane(page).getByTestId("thread-text").filter({ hasText: "both can start now" });
  await dragSelect(page, note, "both can start now");
  await page.getByTestId("cite-button").click();
  await page.keyboard.press("Enter");
  await expect(chips).toHaveCount(2);
  await run.getByRole("button").click();
  await expect(note).toHaveCount(0);
  await chips.nth(1).click();
  await expect(page.getByTestId("cite-popover")).toBeVisible();
  await expect(run).toHaveAttribute("data-expanded", "true");
  await expect(note).toHaveCount(1);
});

// A task link's words, its click to the board at its task and its live state: unit-tested in
// src/components/ember/TaskPointer.test.tsx, EmberPane.test.tsx and BoardSurface.test.tsx.

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
  await expect(notes.getByTestId("ember-task-meta")).toHaveText("1 of 2");
  await expect(notes.getByTestId("ember-task-progress")).toBeVisible();
  await expect(notes.getByTestId("ember-worker")).toHaveCount(3);
  const blocked = board(page).locator('[data-testid="ember-task"][data-task="t-9c0d1e2f"]');
  await expect(blocked.getByTestId("ember-task-outcome")).toHaveText("wails v3.1 needs Go 1.27; the toolchain here is 1.26");
  await expect(blocked.getByTestId("ember-task-branch")).toHaveCount(0);
  // A done task's branch sits under its outcome.
  const flaky = board(page).locator('[data-testid="ember-task"][data-task="t-3a4b5c6d"]');
  await expect(flaky.getByTestId("ember-task-branch")).toHaveText("cf/spawn-timeout-race");
  // The sidebar row, the chat and the panel share one WatchBoard.
  expect((await openStreams())["EmberService/WatchBoard"]).toBe(1);
  // A new todo task lands in Up next, live.
  await mockPost(`ember/task/add?title=${encodeURIComponent("Same for thread read")}`);
  await expect(board(page).getByTestId("ember-board-counts")).toHaveText("3 in progress · 1 up next");
  // A worker row opens its thread (a hidden child of Ember's).
  await notes.locator('[data-testid="ember-worker"][data-thread="s-ember-notes"]').click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ember-notes");
});

// The Scheduled list and its ×: unit-tested in src/components/ember/BoardSurface.test.tsx.

// A lead's team on the board, the row and the header: unit-tested in src/components/ember/BoardSurface.test.tsx,
// EmberRow.test.tsx and EmberPane.test.tsx.

test("a worker waiting on the user: Needs input on the row until it is answered; cmd+shift+a goes to Ember first", async ({ page }) => {
  await enable();
  await openApp(page);
  const status = emberRow(page).getByTestId("ember-row-status");
  await expect(status).toHaveText("Working");
  // A lead's worker asks a question.
  await mockPost(`thread/status?id=s-ember-team-put&status=attention&reason=${encodeURIComponent("question: 404 or 422 for a bad id?")}`);
  await expect(status).toHaveText("Needs input");
  await expect(status).toHaveClass(/text-cf-warning-text/);
  await expect(emberRow(page)).toHaveAttribute("data-flame", "attention");
  if (process.env.SHOTS) await page.getByTestId("sidebar-body").screenshot({ path: `${process.env.SHOTS}/ember-row-needs-input.png` });
  // cmd+shift+a goes to Ember (its row is the first that needs the user).
  await page.keyboard.press("Meta+Shift+a");
  await expect(pane(page)).toBeVisible();
  // Opening the chat does not clear it: only an answer does.
  await expect(status).toHaveText("Needs input");
  await page.getByTestId("ember-board-toggle").click();
  await expect(board(page).locator('[data-testid="ember-worker"][data-thread="s-ember-team-put"]').getByTestId("ember-worker-meta")).toHaveText("Needs input");
  await expect(board(page).locator('[data-testid="ember-task"][data-task="t-4c5d6e7f"]').getByTestId("ember-task-meta")).toHaveText("Needs input");
  // A task's own worker asking counts too, once with the team's.
  await mockPost(`thread/status?id=s-ember-notes&status=attention&reason=${encodeURIComponent("permission: Bash git push")}`);
  await mockPost("thread/status?id=s-ember-notes&status=busy");
  await mockPost("thread/status?id=s-ember-team-put&status=busy");
  await expect(status).toHaveText("Working");
  await expect(emberRow(page)).toHaveAttribute("data-flame", "working");
});

test("paths in Ember's chat: an absolute one under a project is a chip; relative ones and git ranges stay code", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const last = replies(page).filter({ hasText: "The notes API team is under way" });
  await expect(last).toHaveCount(1);
  await expect(last.getByTestId("path-chip")).toHaveCount(1);
  await expect(last.getByTestId("path-plain")).toHaveText(["README.md"]);
  await expect(last.locator("code", { hasText: "main..cf/notes-validation" })).toHaveCount(1);
  await last.getByTestId("path-chip").click();
  await expect(page.getByTestId("file-tab")).toHaveAttribute("data-path", "/Users/dev/src/code-foundry/README.md");
});

// The Board listed only in Ember's chat's panel: unit-tested in src/surfaces/ember.test.tsx.

// Settings › Ember (the nav flame, the worker-model chips): unit-tested in src/components/settings/WorkerModelsEditor.test.tsx.

// ---------- docs/notes/ember-fixes-2-gui.md ----------

// The header's and the row's counts, Needs input and timers: unit-tested in src/components/ember/EmberPane.test.tsx,
// EmberRow.test.tsx and TaskPointer.test.tsx.

// A budget stop on the row and the board: unit-tested in src/components/ember/EmberRow.test.tsx and BoardSurface.test.tsx.

// A task link's board title, glyph, tooltip and branch, and a rename reaching every link: unit-tested in
// src/components/ember/TaskPointer.test.tsx.

test("a restart that cut Ember's turn: a line in the chat, Interrupted on the row, no bare Error", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const status = emberRow(page).getByTestId("ember-row-status");
  await mockPost("ember/restart?step=cut");
  const line = pane(page).getByTestId("ember-restart");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(/^Code Foundry restarted at \S.* while Ember was working$/);
  await expect(status).toHaveText("Interrupted");
  await expect(status).toHaveClass(/text-cf-warning-text/);
  // The cut run still has its row, before the line.
  await expect(pane(page).getByTestId("ember-work").last().getByTestId("ember-work-summary")).toHaveText("started 1 worker");
  // The restart notice wakes Ember; it picks the request up; the line stays where the cut was.
  await mockPost("ember/restart?step=wake");
  await expect(status).not.toHaveText("Interrupted");
  await expect(line).toHaveCount(1);
  await expect(pane(page).getByTestId("ember-work").last().getByTestId("ember-work-summary")).toHaveText("restart, started 1 worker, checked the board");
});

// The board's ages, a done piece's outcome and branch, Worker for a repeated title and a lead's names: unit-tested in
// src/components/ember/BoardSurface.test.tsx.

// ---------- docs/notes/ember-fixes-3-board.md ----------

// An idle worker on a doing task (Worker idle, To check, Blocked) on the row, the header, the link and the board:
// unit-tested in src/components/ember/EmberRow.test.tsx, EmberPane.test.tsx, TaskPointer.test.tsx and BoardSurface.test.tsx.
