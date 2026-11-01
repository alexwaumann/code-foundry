import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

/**
 * The read-only subagent view (docs/notes/subagent-view.md) over the mock's scripted thread
 * s-r1 "Agents panel" in its "agents" state (mock/agents.ts): the done foreground Explore
 * a0 (its work and report), the running background "PR 1" a1 (a work log with a nested
 * Agent call a1b, a running test and a streaming reply), the running "PR 2" a2 and the
 * failed a3 (a short log and its error, with its "Agent failed" note). The view opens from
 * the Agent rows' Open, the notes' Open, the strip's names, the thread info card's agent rows and the
 * CLI (thread.agent.open); Escape, the back buttons, the crumb and the CLI
 * (thread.agent.up) go back up.
 */

const PARENT = "Agents panel";

const view = (page: Page) => page.getByTestId("subagent-pane");
const threadPane = (page: Page) => page.getByTestId("thread-pane");
const agentCall = (page: Page, name: string) => threadPane(page).locator('[data-tool="Agent"]').filter({ hasText: name }).first();

/**
 * Counts the GUI's ThreadService.WatchThread calls (Connect-Web's fetch): entering a run and
 * going back must keep the one stream (ThreadPane's WatchedThread).
 */
function countWatches(page: Page): () => number {
  let n = 0;
  page.on("request", (r) => {
    if (r.url().includes("ThreadService/WatchThread")) n++;
  });
  return () => n;
}

/** Records, from here on, whether "Loading the conversation…" ever shows (a restarted Watch would). */
async function watchForLoading(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __sawLoading?: boolean };
    w.__sawLoading = false;
    new MutationObserver(() => {
      if (document.body.textContent.includes("Loading the conversation")) w.__sawLoading = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function sawLoading(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sawLoading?: boolean }).__sawLoading === true);
}

async function openThread(page: Page): Promise<void> {
  await mockPost("thread?state=agents");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(threadPane(page)).toBeVisible();
}

/** Unfolds the finished turn (every finished turn folds by default) to show its Agent rows. */
async function unfoldTurn(page: Page): Promise<void> {
  const header = page.locator('[data-testid="thread-turn-header"]:not([data-live])').first();
  await header.locator("button.fold").click();
  await expect(header).not.toHaveAttribute("data-folded", "true");
}

/** Opens a run with the hover-only "Open ›" on its Agent row in the parent's timeline. */
async function openFromRow(page: Page, name: string): Promise<void> {
  const call = agentCall(page, name);
  const open = call.getByTestId("thread-agent-open");
  await expect(open).toBeHidden();
  await call.getByTestId("thread-tool").first().hover();
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Open");
  await open.click();
}

/** The view shows this run of s-r1, and the sidebar still has s-r1 selected. */
async function expectViewing(page: Page, runId: string, name: string): Promise<void> {
  await expect(view(page)).toHaveAttribute("data-run-id", runId);
  await expect(view(page)).toHaveAttribute("data-thread-id", "s-r1");
  await expect(page.getByTestId("subagent-name")).toHaveText(name);
  await expect(threadPane(page)).toHaveCount(0);
  await expect(row(page, "s:s-r1")).toHaveAttribute("aria-selected", "true");
}

/** Back at the parent: its timeline, its composer, the run gone from the content pane. */
async function expectParent(page: Page): Promise<void> {
  await expect(view(page)).toHaveCount(0);
  await expect(threadPane(page)).toBeVisible();
  await expect(threadPane(page)).toHaveAttribute("data-thread-id", "s-r1");
  await expect(threadPrompt(page)).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

// The run's view (header, crumb, Read-only, live status, lineage, prompt, its own rows, the
// nested run not openable, footer, plate, no composer or strip): unit-tested in
// src/components/thread/SubagentPane.test.tsx and agentOpen.test.tsx. Left here: the parent's
// Agent row's hover-only Open, through thread.agent.open to the view.
test("Open › on a running Agent row (shown on hover) opens the run read-only", async ({ page }) => {
  await openThread(page);
  await unfoldTurn(page);
  await openFromRow(page, "PR 1: daemon task frames");
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  expect((await invocations()).filter((i) => i.name === "thread.agent.open").map((i) => i.args)).toEqual([{ id: "s-r1", run: "a1" }]);
  await expect(page.getByTestId("subagent-readonly")).toHaveText("Read-only");
  await expect(page.getByTestId("thread-composer")).toHaveCount(0);
});

test("Escape goes back to the parent, the thread still selected, its one Watch kept and no reload", async ({ page }) => {
  const watches = countWatches(page);
  await openThread(page);
  await expect(page.getByTestId("thread-user")).toBeVisible();
  await unfoldTurn(page);
  await threadPrompt(page).click();
  await page.keyboard.type("half a thought");
  const before = watches();
  expect(before).toBeGreaterThan(0);
  await watchForLoading(page);

  await openFromRow(page, "PR 1: daemon task frames");
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  // The view takes the keyboard when it opens: Escape goes straight back.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")).toBe("subagent-pane");
  // Escape closes the palette first (the view does not steal it), then goes up.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(view(page)).toBeVisible();
  await view(page).click({ position: { x: 300, y: 200 } });
  await page.keyboard.press("Escape");
  await expectParent(page);
  // The thread kept: the sidebar selection, its conversation (no reload), the prompt has the keyboard.
  await expect(row(page, "s:s-r1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("thread-user").first()).toContainText("Build the agents panel");
  await expect(threadPane(page)).toContainText("Both PRs are building in the background");
  await expect(threadPrompt(page)).toBeFocused();
  await expect(threadPrompt(page)).toContainText("half a thought");
  // A visit to one of its runs is not leaving the thread: the turn the reader unfolded stays open.
  await expect(page.locator('[data-testid="thread-turn-header"]:not([data-live])').first()).not.toHaveAttribute("data-folded", "true");
  await expect(agentCall(page, "PR 1: daemon task frames")).toBeVisible();
  expect(await sawLoading(page)).toBe(false);
  expect(watches()).toBe(before);
  // Escape in the parent's prompt does not reopen anything.
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  expect(watches()).toBe(before);
});

// The back buttons and the crumb going up: unit-tested in src/components/thread/SubagentPane.test.tsx

// A strip name opening its run (agentOpen.test.tsx), the card's agent rows opening theirs, the
// finished under Previous agents (src/components/threadinfo/LineageAgents.test.tsx), and the done
// Explore's view (done status, lineage, its group, its report once): SubagentPane.test.tsx.

// The run ending while viewed (done in place, its report, no handback row): unit-tested in
// src/components/thread/SubagentPane.test.tsx and src/lib/subagentView.test.ts.

// The failed run's view (its Bash rows, the error, the plate) and another run failing while
// viewed: unit-tested in src/components/thread/SubagentPane.test.tsx. Left here: the note's Open,
// shown on hover only.
test("the failed run's note has an Open on hover that opens the run", async ({ page }) => {
  await openThread(page);
  const note = page.getByTestId("thread-agent-note");
  const open = note.getByTestId("thread-agent-note-open");
  await expect(open).toBeHidden();
  await note.hover();
  await open.click();
  await expectViewing(page, "a3", "Screenshot the panel in Wails");
  await expect(page.getByTestId("subagent-status")).toHaveAttribute("data-status", "failed");
});

// Selecting another thread drops the view: unit-tested in src/stores/subagentView.test.ts

// thread.agent.open from the CLI showing the run and thread.agent.up going back: src/stores/subagentView.test.ts ("UiIntent.ShowAgentRun shows the run, ShowView agent.up leaves it"); the palette not listing it: subagentView.test.ts and internal/command/palette_test.go; Back to Parent's Esc: src/keys/chord.test.ts; nested and unknown runs refused: internal/command/commands_agents_view_test.go.
