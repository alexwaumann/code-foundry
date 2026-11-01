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

// The row showing only while Ember is on, its status, task, thread count and flame:
// src/components/ember/EmberRow.test.tsx; the thread list never listing Ember: src/components/sidebar/Sidebar.test.tsx.
test("the row sits 8px under the menu pane, above the first thread row", async ({ page }) => {
  await enable();
  await openApp(page);
  await expect(emberRow(page)).toBeVisible();
  const rowBox = await emberRow(page).boundingBox();
  const menuBox = await page.getByTestId("sidebar-menu").boundingBox();
  const firstBox = await page.locator('[data-testid="sidebar-main"] [role="option"]').first().boundingBox();
  expect(rowBox && menuBox && rowBox.y - (menuBox.y + menuBox.height)).toBe(8);
  expect(rowBox && firstBox && rowBox.y + rowBox.height <= firstBox.y).toBe(true);
});

// The row opening the chat (selected), the chat's header and prompt, and the row's menu: src/components/ember/EmberRow.test.tsx ("a click opens the chat…", "its menu: Open board and Settings only…") and EmberPane.test.tsx ("the flame and Ember, the board's summary…").

// The arrows reaching the row from the thread list (Home, Enter, ↓ and ↑ back): src/components/sidebar/Sidebar.test.tsx ("Ember's row").

// What each run did in Ember's words and when it ended: src/lib/ember.test.ts (workSummary, workMs);
// the fold and one run opening in place: src/components/ember/EmberTimeline.test.tsx; Show work's
// store choice: src/components/ember/EmberPane.test.tsx. What is left is the virtualized chat.
test("work folds into Worked for rows; one opens in place after a wheel up; Show work mounts every run open", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  const work = pane(page).getByTestId("ember-work");
  await expect(work).toHaveCount(7);
  await wheelTo(page, work.nth(1));
  await work.nth(1).getByRole("button").click();
  await expect(work.nth(1)).toHaveAttribute("data-expanded", "true");
  await expect(pane(page).getByTestId("thread-wake-note")).toHaveCount(1);
  await expect(work.nth(0)).not.toHaveAttribute("data-expanded", "true");
  await page.getByTestId("ember-show-work").click();
  await expect(page.getByTestId("ember-show-work")).toHaveAttribute("aria-pressed", "true");
  // Every row on screen (the open runs push the rest out of the virtualized list).
  const expanded = () => work.evaluateAll((els) => els.map((e) => e.hasAttribute("data-expanded")));
  await expect.poll(async () => (await expanded()).every(Boolean)).toBe(true);
  await page.getByTestId("ember-show-work").click();
  await expect.poll(async () => (await expanded()).some(Boolean)).toBe(false);
});

// Only a turn's last text being the reply (Copy answer, its task links), text between tool calls folding
// into the run and opening with it: src/components/ember/EmberTimeline.test.tsx; the rule: src/lib/ember.test.ts.

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

// The board's sections, counts, cards, worker rows, a live new task and a worker row's click:
// src/components/ember/BoardSurface.test.tsx.
test("the sidebar row, the chat and the board panel share one WatchBoard stream", async ({ page }) => {
  await enable();
  await openApp(page);
  await openChat(page);
  await page.getByTestId("ember-board-toggle").click();
  await expect(board(page).getByTestId("ember-board-counts")).toBeVisible();
  expect((await openStreams())["EmberService/WatchBoard"]).toBe(1);
});

// The Scheduled list and its ×: unit-tested in src/components/ember/BoardSurface.test.tsx.

// A lead's team on the board, the row and the header: unit-tested in src/components/ember/BoardSurface.test.tsx,
// EmberRow.test.tsx and EmberPane.test.tsx.

// Needs input on the row (amber, the flame) and on the board's worker and card, and back to Working once
// answered: src/components/ember/EmberRow.test.tsx and BoardSurface.test.tsx.
test("a worker waiting on the user: cmd+shift+a goes to Ember first (its row is the first that needs the user)", async ({ page }) => {
  await enable();
  await openApp(page);
  const status = emberRow(page).getByTestId("ember-row-status");
  await mockPost(`thread/status?id=s-ember-team-put&status=attention&reason=${encodeURIComponent("question: 404 or 422 for a bad id?")}`);
  await expect(status).toHaveText("Needs input");
  if (process.env.SHOTS) await page.getByTestId("sidebar-body").screenshot({ path: `${process.env.SHOTS}/ember-row-needs-input.png` });
  await page.keyboard.press("Meta+Shift+a");
  await expect(pane(page)).toBeVisible();
  // Opening the chat does not clear it: only an answer does.
  await expect(status).toHaveText("Needs input");
});

// Paths in Ember's chat (an absolute one under a project a chip opening the File tab, relative ones and
// git ranges code): src/components/ember/EmberTimeline.test.tsx.

// The Board listed only in Ember's chat's panel: unit-tested in src/surfaces/ember.test.tsx.

// Settings › Ember (the nav flame, the worker-model chips): unit-tested in src/components/settings/WorkerModelsEditor.test.tsx.

// ---------- docs/notes/ember-fixes-2-gui.md ----------

// The header's and the row's counts, Needs input and timers: unit-tested in src/components/ember/EmberPane.test.tsx,
// EmberRow.test.tsx and TaskPointer.test.tsx.

// A budget stop on the row and the board: unit-tested in src/components/ember/EmberRow.test.tsx and BoardSurface.test.tsx.

// A task link's board title, glyph, tooltip and branch, and a rename reaching every link: unit-tested in
// src/components/ember/TaskPointer.test.tsx.

// A restart that cut Ember's turn (the line after the cut run, Interrupted on the row, the line staying once
// Ember picks up): src/components/ember/EmberTimeline.test.tsx; finding the cut: src/lib/ember.test.ts (restartCuts).

// The board's ages, a done piece's outcome and branch, Worker for a repeated title and a lead's names: unit-tested in
// src/components/ember/BoardSurface.test.tsx.

// ---------- docs/notes/ember-fixes-3-board.md ----------

// An idle worker on a doing task (Worker idle, To check, Blocked) on the row, the header, the link and the board:
// unit-tested in src/components/ember/EmberRow.test.tsx, EmberPane.test.tsx, TaskPointer.test.tsx and BoardSurface.test.tsx.
