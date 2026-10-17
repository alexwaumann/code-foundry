import { expect, test, type Page } from "@playwright/test";
import { emit, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Subagent runs in the GUI (docs/notes/agents-2-gui.md, docs/sketches/agents-panel L1)
 * over the mock's scripted thread s-r1 in its "agents" state (mock/agents.ts): a finished
 * Explore, two background runs still running ("PR 1", "PR 2"), a nested run under PR 1,
 * and a failed background run with its note, plus one background shell; idle at its
 * prompt. The "shells" state has background shells only (mock/shells.ts). Set SHOTS=<dir>
 * to save screenshots (WebKit, dark and light).
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const surface = (page: Page) => page.getByTestId("agents-surface");
const agentRow = (page: Page, id: string) => surface(page).locator(`[data-testid="agent-row"][data-agent="${id}"]`);
const strip = (page: Page) => page.getByTestId("agents-strip");

async function openThread(page: Page, state = "agents"): Promise<void> {
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

async function expectAgentsTab(page: Page): Promise<void> {
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-r1");
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveText("Agents");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "agents");
}

/** Unfolds the finished turn (every finished turn folds by default) to show its Agent rows. */
async function unfoldTurn(page: Page): Promise<void> {
  const header = page.locator('[data-testid="thread-turn-header"]:not([data-live])').first();
  await header.locator("button.fold").click();
  await expect(header).not.toHaveAttribute("data-folded", "true");
}

test.beforeEach(async () => {
  await resetMock();
});

test("A opens the tab: runs in spawn order, the nested one under its parent, every state", async ({ page }) => {
  await openThread(page);
  // A in the panel's surface list (the header's toggle opens the panel and focuses it).
  await page.getByTestId("thread-pane").getByRole("button", { name: "Toggle Side Panel" }).click();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="agents"]')).toBeVisible();
  await page.keyboard.press("a");
  await expectAgentsTab(page);

  await expect(surface(page).getByTestId("agents-count")).toHaveText("3 running · 5 this thread");
  await expect(surface(page).getByTestId("agents-subline")).toHaveText("2 in the background keep running after the turn ends");
  const rows = surface(page).getByTestId("agent-row");
  await expect(rows).toHaveCount(5);
  // Spawn order (a1b started last) with the nested run right under its parent.
  expect(await rows.evaluateAll((els) => els.map((e) => [e.getAttribute("data-agent"), e.getAttribute("data-level"), e.getAttribute("data-status")]))).toEqual([
    ["a0", "0", "done"],
    ["a1", "0", "running"],
    ["a1b", "1", "running"],
    ["a2", "0", "running"],
    ["a3", "0", "failed"],
  ]);
  await expect(rows.getByTestId("agent-name")).toHaveText(["Find the header chip pattern", "PR 1: daemon task frames", "Review usage_runs changes", "PR 2: Agents surface in the panel", "Screenshot the panel in Wails"]);
  await expect(rows.getByTestId("agent-status")).toHaveText(["Done · 5 min ago", "Running", "Running", "Running", "Failed · 3 min ago"]);
  await expect(rows.getByTestId("agent-meta")).toHaveText([
    "Explore·haiku·foreground",
    "general-purpose·opus·high·background",
    "Explore·foreground",
    "general-purpose·opus·high·background",
    "claude·background",
  ]);
  await expect(agentRow(page, "a0").getByTestId("agent-summary")).toContainText("LinkedPrs in HeaderActions.tsx renders a CommandButton");
  await expect(agentRow(page, "a1").getByTestId("agent-activity")).toHaveText("Running go test ./internal/store/...Bash");
  await expect(agentRow(page, "a3").getByTestId("agent-error")).toHaveText("Stopped: process exited with code 1");
  await expect(agentRow(page, "a0").getByTestId("agent-elapsed")).toHaveText("12s");
  await expect(agentRow(page, "a0").getByTestId("agent-tools")).toHaveText("6");
  await expect(agentRow(page, "a0").getByTestId("agent-tokens")).toHaveText("9.4K");
  await expect(agentRow(page, "a1").getByTestId("agent-elapsed")).toHaveText(/^4m \d\ds$/);
  // Rows are not clickable in v1.
  await expect(surface(page).locator("button")).toHaveCount(0);

  // The separators run border to border: a row is as wide as the panel's body.
  const body = await page.getByTestId("panel-body").boundingBox();
  const first = await agentRow(page, "a0").boundingBox();
  expect(Math.abs((first?.width ?? 0) - (body?.width ?? 0))).toBeLessThan(2);
});

test("view.panel.agents and the palette open it; a run ending moves only its row", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.agents" } })).toBeGreaterThan(0);
  await expectAgentsTab(page);
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Agents");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.agents"]').click();
  await expect(palette).toHaveCount(0);
  await expectAgentsTab(page);

  await mockPost("thread/agent-end?run=a1");
  await expect(agentRow(page, "a1")).toHaveAttribute("data-status", "done");
  await expect(agentRow(page, "a1").getByTestId("agent-status")).toHaveText("Done · just now");
  await expect(agentRow(page, "a1").getByTestId("agent-summary")).toHaveText("Added task frame handling to the thread store with 14 table tests; make check is green.");
  await expect(surface(page).getByTestId("agents-count")).toHaveText("2 running · 5 this thread");
  // Never reordered by status.
  await expect(surface(page).getByTestId("agent-row")).toHaveCount(5);
  expect(await surface(page).getByTestId("agent-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-agent")))).toEqual(["a0", "a1", "a1b", "a2", "a3"]);
});

test("the strip shows only background runs, opens the tab, and goes when they end; the sidebar counts every run", async ({ page }) => {
  await openThread(page);
  await expect(strip(page)).toBeVisible();
  // One sentence for the background agents and the thread's background shell.
  await expect(strip(page).getByTestId("agents-strip-count")).toHaveText("2 agents and 1 shell running in the background");
  await expect(strip(page)).toHaveAttribute("data-kind", "agents");
  // The nested foreground run is not named; the two background ones are, with their activity.
  await expect(strip(page).getByTestId("agents-strip-runs")).toHaveText("PR 1: daemon task frames · Running go test ./internal/store/...PR 2: Agents surface in the panel · Editing AgentsSurface.tsx");
  await expect(row(page, "s:s-r1").getByTestId("row-agents")).toHaveText("3 agents");

  await strip(page).getByTestId("agents-strip-open").click();
  await expectAgentsTab(page);

  await mockPost("thread/agent-end?run=a1");
  await expect(strip(page).getByTestId("agents-strip-count")).toHaveText("1 agent and 1 shell running in the background");
  await expect(strip(page).getByTestId("agents-strip-runs")).toHaveText("PR 2: Agents surface in the panel · Editing AgentsSurface.tsx");
  await expect(row(page, "s:s-r1").getByTestId("row-agents")).toHaveText("2 agents");

  // The last background run ends: the shell keeps the strip, as the sentence alone.
  await mockPost("thread/agent-end?run=a2&status=failed");
  await expect(strip(page)).toHaveAttribute("data-kind", "shells");
  await expect(strip(page)).toHaveText("1 shell running in the background");
  await expect(strip(page).getByTestId("agents-strip-open")).toHaveCount(0);
  // The shell ends: the strip goes, though the nested foreground run runs on.
  await mockPost("thread/shell-end");
  await expect(strip(page)).toHaveCount(0);
  await expect(row(page, "s:s-r1").getByTestId("row-agents")).toHaveText("1 agent");
  await mockPost("thread/agent-end?run=a1b");
  await expect(row(page, "s:s-r1").getByTestId("row-agents")).toHaveCount(0);
});

test("background shells only: the sentence behind a terminal icon, the calls run until their shell ends", async ({ page }) => {
  await openThread(page, "shells");
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toHaveAttribute("data-kind", "shells");
  await expect(strip(page)).toHaveText("2 shells running in the background");
  await expect(strip(page).locator(".lucide-square-terminal")).toHaveCount(1);
  await expect(strip(page).locator(".lucide-bot")).toHaveCount(0);
  await expect(strip(page).getByTestId("agents-strip-runs")).toHaveCount(0);
  await expect(strip(page).getByTestId("agents-strip-open")).toHaveCount(0);
  // No agents: the sidebar says nothing about them.
  await expect(row(page, "s:s-r1").getByTestId("row-agents")).toHaveCount(0);

  await unfoldTurn(page);
  const bash = page.locator('[data-tool="Bash"]').filter({ hasText: "make gui-e2e" });
  const monitor = page.locator('[data-tool="Monitor"]');
  await expect(bash).toHaveAttribute("data-status", "running");
  await expect(monitor).toHaveAttribute("data-status", "running");

  await mockPost("thread/shell-end");
  await expect(strip(page)).toHaveText("1 shell running in the background");
  await expect(bash).toHaveAttribute("data-status", "done");
  await expect(monitor).toHaveAttribute("data-status", "running");
  await mockPost("thread/shell-end");
  await expect(strip(page)).toHaveCount(0);
  await expect(monitor).toHaveAttribute("data-status", "done");
});

test("the timeline: background and failed chips, live activity, and the end notes", async ({ page }) => {
  await openThread(page);
  // The failed run's note shows in the folded turn: a red cross, the name, the error.
  const notes = page.getByTestId("thread-agent-note");
  await expect(notes).toHaveCount(1);
  await expect(notes.first()).toHaveAttribute("data-failed", "true");
  await expect(notes.first().getByTestId("thread-agent-note-name")).toHaveText("Screenshot the panel in Wails");
  await expect(notes.first().getByTestId("thread-agent-note-summary")).toHaveText("Stopped: process exited with code 1");
  await expect(notes.first()).toContainText("Agent failed");
  await expect(page.getByTestId("thread-note")).toHaveCount(0);

  await unfoldTurn(page);
  const agents = page.locator('[data-tool="Agent"]').filter({ has: page.getByTestId("thread-agent-bg") });
  await expect(agents).toHaveCount(3);
  const pr1 = page.locator('[data-tool="Agent"]').filter({ hasText: "PR 1: daemon task frames" });
  await expect(pr1).toHaveAttribute("data-status", "running");
  await expect(pr1.getByTestId("thread-agent-activity")).toHaveText("Running go test ./internal/store/...");
  await expect(pr1.getByTestId("thread-agent-elapsed")).toHaveText(/^4m \d\ds$/);
  await expect(pr1.getByLabel("Running")).toBeVisible();
  // Background rows stay a line; the failed one carries both chips.
  await expect(pr1.getByTestId("thread-tool").first()).toHaveAttribute("aria-expanded", "false");
  const shot = page.locator('[data-tool="Agent"]').filter({ hasText: "Screenshot the panel in Wails" });
  await expect(shot.getByTestId("thread-agent-failed")).toHaveText("failed");
  await expect(shot.getByTestId("thread-agent-bg")).toHaveText("background");

  // PR 1 ends: its row stops, a finished note (green check) follows.
  await mockPost("thread/agent-end?run=a1");
  await expect(pr1).toHaveAttribute("data-status", "done");
  await expect(pr1.getByTestId("thread-agent-activity")).toHaveCount(0);
  await expect(notes).toHaveCount(2);
  const done = notes.last();
  await expect(done).not.toHaveAttribute("data-failed", "true");
  await expect(done.getByTestId("thread-agent-note-name")).toHaveText("PR 1: daemon task frames");
  await expect(done.getByTestId("thread-agent-note-summary")).toHaveText("Added task frame handling to the thread store with 14 table tests; make check is green.");
  await expect(done).toContainText("just now");
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openThread(page);
    await unfoldTurn(page);
    expect(await emit({ showView: { name: "panel.agents" } })).toBeGreaterThan(0);
    await expectAgentsTab(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/agents-${scheme}.png` });
  });
}

/** SHOTS=<dir>: the strip with agents and a shell, and with shells only, WebKit, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`strip screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [state, name, text] of [
      ["agents", "agents-and-shell", "2 agents and 1 shell running in the background"],
      ["shells", "shells-only", "2 shells running in the background"],
    ] as const) {
      await openThread(page, state);
      await expect(strip(page).getByTestId("agents-strip-count")).toHaveText(text);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${String(shots)}/strip-${name}-${scheme}.png` });
      await page.locator(".dock").first().screenshot({ path: `${String(shots)}/strip-${name}-${scheme}-dock.png` });
    }
  });
}
