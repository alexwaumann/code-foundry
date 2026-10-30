import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { invocations, mockPost, mockUrl, openApp, resetMock, row, threadPrompt } from "./fixtures";

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
const PR1_PROMPT = "Implement PR 1: the daemon side of the agents panel.";
const EXPLORE_REPORT = "LinkedPrs in HeaderActions.tsx renders a CommandButton with a count when there are 2+ PRs";

const view = (page: Page) => page.getByTestId("subagent-pane");
const threadPane = (page: Page) => page.getByTestId("thread-pane");
const card = (page: Page) => page.getByTestId("thread-info-card");
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

/** Opens one of the thread's runs from the thread info card's agent rows (finished ones under Previous). */
async function openFromCard(page: Page, runId: string): Promise<void> {
  if ((await page.getByTestId("thread-info-toggle").getAttribute("aria-pressed")) !== "true") await page.getByTestId("thread-info-toggle").click();
  await expect(card(page)).toBeVisible();
  const runRow = card(page).locator(`[data-testid="ti-lineage-row"][data-kind="agent"][data-id="${runId}"]`);
  const previous = card(page).getByTestId("ti-previous");
  if ((await runRow.count()) === 0 && (await previous.count()) > 0) await previous.click();
  await runRow.click();
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

/**
 * CommandService.Invoke as the CLI calls it: no window (no active view), the thread its
 * --id names as the context's thread. Expects it to succeed or fail.
 */
async function cli(ok: boolean, name: string, args: Record<string, string> = {}): Promise<void> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, context: args.id ? { activeThreadId: args.id } : undefined }),
  });
  expect(res.ok, `${name}: ${await res.text()}`).toBe(ok);
}

test.beforeEach(async () => {
  await resetMock();
});

test("Open › on a running Agent row shows the run read-only: header, lineage, prompt, its own rows, footer, plate", async ({ page }) => {
  await openThread(page);
  await unfoldTurn(page);
  await openFromRow(page, "PR 1: daemon task frames");
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  expect((await invocations()).filter((i) => i.name === "thread.agent.open").map((i) => i.args)).toEqual([{ id: "s-r1", run: "a1" }]);

  // Header: back, the crumb (parent › run), Read-only, the live status, the panel toggle only.
  const header = page.getByTestId("subagent-header");
  await expect(header.getByTestId("subagent-back")).toBeVisible();
  await expect(header.getByTestId("subagent-crumb-parent")).toHaveText(PARENT);
  await expect(header.getByTestId("subagent-readonly")).toHaveText("Read-only");
  await expect(header.getByTestId("subagent-status")).toHaveAttribute("data-status", "running");
  await expect(header.getByTestId("subagent-status")).toHaveText(/^Running · 4m \d\ds$/);
  // No thread actions: a subagent has no connection, snooze, archive or bottom panel.
  await expect(header.getByTestId("pane-actions").getByRole("button")).toHaveCount(1);
  await expect(header.getByTestId("panel-toggle")).toBeVisible();
  await expect(header.getByTestId("bottom-toggle")).toHaveCount(0);
  await expect(header.locator('[data-command-button="thread.archive"], [data-command-button="thread.snooze"]')).toHaveCount(0);

  // The lineage note and the prompt the parent gave it.
  const lineage = view(page).getByTestId("subagent-lineage");
  await expect(lineage).toContainText(`Subagent of${PARENT}`);
  await expect(lineage.getByTestId("subagent-lineage-meta")).toHaveText(/^background · general-purpose · opus · high · launched by turn 1's Agent call, 4 min ago$/);
  await expect(lineage.getByTestId("subagent-lineage-back")).toHaveText(`Back to ${PARENT}`);
  const prompt = view(page).getByTestId("subagent-prompt");
  await expect(prompt.getByTestId("thread-user-label")).toHaveText(`Prompt from ${PARENT}`);
  await expect(prompt).toContainText(PR1_PROMPT);

  // Its own rows (parent = its Agent call) in order, nothing of the parent's or of the other runs'.
  await expect(view(page).getByRole("button", { name: /^Thought for 6s/ })).toBeVisible();
  await expect(view(page).getByRole("button", { name: /^Read 1 file, searched code once/ })).toBeVisible();
  const tools = view(page).locator("[data-tool]");
  expect(await tools.evaluateAll((els) => els.map((e) => e.getAttribute("data-tool")))).toEqual(["Agent", "Edit", "Write", "Bash"]);
  await expect(view(page).locator('[data-tool="Bash"]')).toHaveAttribute("data-status", "running");
  await expect(view(page).locator('[data-tool="Agent"]')).toHaveAttribute("data-status", "running");
  const text = view(page).getByTestId("thread-text");
  await expect(text).toHaveCount(1);
  await expect(text).toContainText("Tests for the frame parser pass");
  await expect(text).toHaveAttribute("data-streaming", "true");
  await expect(view(page)).not.toContainText("Both PRs are building in the background");
  await expect(view(page)).not.toContainText("make gui-build");
  // The nested Agent call shows its run's chips, but nothing opens it and it has no children.
  const nested = view(page).locator('[data-tool="Agent"]');
  await expect(nested).toContainText("Review usage_runs changes");
  await expect(view(page).getByTestId("thread-agent-open")).toHaveCount(0);
  await nested.getByTestId("thread-tool").first().hover();
  await expect(nested.getByTestId("thread-agent-open")).toHaveCount(0);
  // One line: while it runs there is nothing to open.
  await expect(nested.getByTestId("thread-tool").first()).not.toHaveAttribute("aria-expanded");
  await nested.getByTestId("thread-tool").first().click();
  await expect(nested.locator("[data-tool]")).toHaveCount(0);

  // The footer, no report yet, and the plate where the composer would be.
  const footer = view(page).getByTestId("subagent-footer");
  await expect(footer).toHaveAttribute("data-status", "running");
  await expect(footer).toHaveText(/^Working for 4m \d\ds·23 tools·48\.2K tokens·opus$/);
  await expect(view(page).getByTestId("subagent-report")).toHaveCount(0);
  await expect(page.getByTestId("subagent-plate-text")).toHaveText(`Read-only. A subagent takes its instructions from its parent thread. To steer it, send a follow-up to ${PARENT}.`);
  await expect(page.getByTestId("subagent-plate-back")).toContainText(`Back to ${PARENT}`);
  await expect(page.getByTestId("subagent-plate-chord")).toHaveText("esc");
  await expect(page.getByTestId("thread-composer")).toHaveCount(0);
  await expect(page.getByTestId("agents-strip")).toHaveCount(0);
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

test("the header's back button and crumb, the note's and the plate's Back each go up", async ({ page }) => {
  await openThread(page);
  await unfoldTurn(page);
  for (const back of ["subagent-back", "subagent-crumb-parent", "subagent-lineage-back", "subagent-plate-back"]) {
    await openFromRow(page, "PR 1: daemon task frames");
    await expectViewing(page, "a1", "PR 1: daemon task frames");
    await page.getByTestId(back).click();
    await expectParent(page);
  }
});

test("a strip name opens its background run; the done Explore opened from the card shows its report once", async ({ page }) => {
  await openThread(page);
  const name = page.getByTestId("agents-strip").getByTestId("agents-strip-name");
  await expect(name).toHaveText(["PR 1: daemon task frames", "PR 2: Agents surface in the panel"]);
  // The line is one ellipsised line: the first name is the one in view at this width.
  await name.first().click();
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  await expect(page.getByTestId("subagent-prompt")).toContainText(PR1_PROMPT);
  await page.keyboard.press("Escape");
  await expectParent(page);

  await openFromCard(page, "a0");
  await expectViewing(page, "a0", "Find the header chip pattern");
  await expect(page.getByTestId("subagent-status")).toHaveText("Done · 5 min ago");
  await expect(page.getByTestId("subagent-lineage-meta")).toHaveText(/^foreground · Explore · haiku · launched by turn 1's Agent call, [56] min ago$/);
  await expect(view(page).getByRole("button", { name: /^Read 1 file, searched code once HeaderActions.tsx/ })).toBeVisible();
  await expect(view(page).locator("[data-tool]")).toHaveCount(0);
  await expect(page.getByTestId("subagent-footer")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("subagent-footer")).toHaveText("Worked for 12s·6 tools·9.4K tokens·haiku");
  // Its report is its last text: shown once, as the text, no separate block.
  await expect(view(page).getByTestId("thread-text")).toContainText(EXPLORE_REPORT);
  await expect(view(page).getByTestId("subagent-report")).toHaveCount(0);
  await expect(page.getByTestId("subagent-plate-text")).toHaveText(`Read-only. This agent finished and handed its report to ${PARENT}.`);
});

test("the run ending while viewed turns the view done in place, with the report it handed back", async ({ page }) => {
  await openThread(page);
  await openFromCard(page, "a1");
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  await expect(page.getByTestId("subagent-status")).toHaveAttribute("data-status", "running");

  await mockPost("thread/agent-end?run=a1");
  await expect(page.getByTestId("subagent-status")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("subagent-status")).toHaveText("Done · just now");
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  const footer = page.getByTestId("subagent-footer");
  await expect(footer).toHaveAttribute("data-status", "done");
  await expect(footer).toHaveText(/^Worked for 4m \d\ds·23 tools·48\.2K tokens·opus$/);
  // Its running test and its streaming reply stop with it.
  await expect(view(page).locator('[data-tool="Bash"]')).toHaveAttribute("data-status", "done");
  await expect(view(page).getByTestId("thread-text")).not.toHaveAttribute("data-streaming", "true");
  // It handed the report back with a SubagentHandback call (not its last text): the
  // report shows as the block, the call is no row of its own.
  await expect(view(page).locator('[data-tool="SubagentHandback"]')).toHaveCount(0);
  expect(await view(page).locator("[data-tool]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tool")))).toEqual(["Agent", "Edit", "Write", "Bash"]);
  const report = page.getByTestId("subagent-report");
  await expect(report).toContainText(`Report handed back to ${PARENT}`);
  await expect(report).toContainText("Added task frame handling to the thread store with 14 table tests; make check is green.");
  await expect(page.getByTestId("subagent-plate-text")).toHaveText(`Read-only. This agent finished and handed its report to ${PARENT}.`);
});

test("the failed run opened from its note shows its error; another run failing while viewed turns red in place", async ({ page }) => {
  await openThread(page);
  // The failed run's note is in the folded turn; its Open shows on hover.
  const note = page.getByTestId("thread-agent-note");
  const open = note.getByTestId("thread-agent-note-open");
  await expect(open).toBeHidden();
  await note.hover();
  await open.click();
  await expectViewing(page, "a3", "Screenshot the panel in Wails");
  await expect(page.getByTestId("subagent-status")).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("subagent-status")).toHaveText("Failed · 3 min ago");
  const bash = view(page).locator('[data-tool="Bash"]');
  await expect(bash).toHaveCount(2);
  await expect(bash.nth(1)).toHaveAttribute("data-status", "error");
  const footer = page.getByTestId("subagent-footer");
  await expect(footer).toHaveAttribute("data-status", "failed");
  await expect(footer).toContainText("Stopped: process exited with code 1");
  await expect(page.getByTestId("subagent-report")).toHaveCount(0);
  await expect(page.getByTestId("subagent-plate-text")).toHaveText(`Read-only. This agent failed. Its parent ${PARENT} was told.`);
  await page.keyboard.press("Escape");
  await expectParent(page);

  await openFromCard(page, "a2");
  await expectViewing(page, "a2", "PR 2: Agents surface in the panel");
  await mockPost("thread/agent-end?run=a2&status=failed");
  await expect(page.getByTestId("subagent-status")).toHaveAttribute("data-status", "failed");
  await expect(footer).toHaveAttribute("data-status", "failed");
  await expect(footer).toContainText("Stopped: the agent was killed");
  await expect(page.getByTestId("subagent-plate-text")).toHaveText(`Read-only. This agent failed. Its parent ${PARENT} was told.`);
  await expectViewing(page, "a2", "PR 2: Agents surface in the panel");
});

test("switching to another thread drops the view; coming back shows the thread", async ({ page }) => {
  await openThread(page);
  await unfoldTurn(page);
  await openFromRow(page, "PR 1: daemon task frames");
  await expectViewing(page, "a1", "PR 1: daemon task frames");
  await row(page, "s:s-2").click();
  await expect(threadPane(page)).toHaveAttribute("data-thread-id", "s-2");
  await expect(view(page)).toHaveCount(0);
  await row(page, "s:s-r1").click();
  await expect(threadPane(page)).toHaveAttribute("data-thread-id", "s-r1");
  await expect(view(page)).toHaveCount(0);
});

test("thread.agent.open from the CLI selects the thread and shows the run; the palette does not list it; thread.agent.up goes back", async ({ page }) => {
  await mockPost("thread?state=agents");
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(threadPane(page)).toHaveAttribute("data-thread-id", "s-2");

  await cli(true, "thread.agent.open", { id: "s-r1", run: "a0" });
  await expectViewing(page, "a0", "Find the header chip pattern");
  // Another run of it, while one shows; a nested run and an unknown one are refused.
  await cli(true, "thread.agent.open", { id: "s-r1", run: "a3" });
  await expectViewing(page, "a3", "Screenshot the panel in Wails");
  await cli(false, "thread.agent.open", { id: "s-r1", run: "a1b" });
  await cli(false, "thread.agent.open", { id: "s-r1", run: "zz" });
  await expectViewing(page, "a3", "Screenshot the panel in Wails");

  // The palette: no Open Subagent (it takes a run id it cannot pick), Back to Parent Thread with its Escape.
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("Subagent");
  await expect(palette.locator('[data-command="thread.agent.open"]')).toHaveCount(0);
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Back to Parent");
  await expect(palette.locator('[data-command="thread.agent.up"]')).toBeVisible();
  await expect(palette.locator('[data-command="thread.agent.up"]')).toContainText(/esc/i);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expectViewing(page, "a3", "Screenshot the panel in Wails");

  // The CLI's thread.agent.up reaches the window through ShowView "agent.up".
  await cli(true, "thread.agent.up");
  await expectParent(page);
  expect((await invocations()).map((i) => i.name)).toContain("thread.agent.up");
});
