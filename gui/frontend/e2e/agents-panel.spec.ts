import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Subagent runs in the GUI (docs/notes/agents-2-gui.md; the Agents tab is gone,
 * docs/notes/thread-header-crumb.md: the thread info card lists the runs) over the mock's
 * scripted thread s-r1 in its "agents" state (mock/agents.ts): a finished
 * Explore, two background runs still running ("PR 1", "PR 2"), a nested run under PR 1,
 * and a failed background run with its note, plus one background shell; idle at its
 * prompt. The "shells" state has background shells only (mock/shells.ts). Set SHOTS=<dir>
 * to save screenshots (WebKit, dark and light).
 */

const strip = (page: Page) => page.getByTestId("agents-strip");

async function openThread(page: Page, state = "agents"): Promise<void> {
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
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

// The strip's count, kind and run names as runs end, and the row's badge: unit-tested in
// src/components/thread/AgentsStrip.test.tsx and src/components/sidebar/SidebarRow.test.tsx.

test("background shells only: no strip (the card's Shells group has them), the calls run until their shell ends", async ({ page }) => {
  await openThread(page, "shells");
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
  // No agents: the sidebar says nothing about them.
  await expect(row(page, "s:s-r1").getByTestId("row-bg-agents")).toHaveCount(0);
  await expect(row(page, "s:s-r1").getByTestId("row-bg-shells")).toBeVisible();

  await unfoldTurn(page);
  const bash = page.locator('[data-tool="Bash"]').filter({ hasText: "make gui-e2e" });
  const monitor = page.locator('[data-tool="Monitor"]');
  await expect(bash).toHaveAttribute("data-status", "running");
  await expect(monitor).toHaveAttribute("data-status", "running");

  await mockPost("thread/shell-end");
  await expect(bash).toHaveAttribute("data-status", "done");
  await expect(monitor).toHaveAttribute("data-status", "running");
  await mockPost("thread/shell-end");
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
  // Every Agent row is one line: nothing to open while its run works, and none of its
  // run's rows (PR 1 has a work log and a nested run) in the thread; the failed one
  // carries both chips.
  await expect(pr1.getByTestId("thread-tool").first()).not.toHaveAttribute("aria-expanded");
  await pr1.getByTestId("thread-tool").first().click();
  await expect(pr1.locator("[data-tool]")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).not.toContainText("Review usage_runs changes");
  await expect(page.getByTestId("thread-pane")).not.toContainText("-run TestAgent");
  const shot = page.locator('[data-tool="Agent"]').filter({ hasText: "Screenshot the panel in Wails" });
  await expect(shot.getByTestId("thread-agent-failed")).toHaveText("failed");
  await expect(shot.getByTestId("thread-agent-bg")).toHaveText("background");

  // PR 1 ends: its row stops, a finished note (green check) follows.
  await mockPost("thread/agent-end?run=a1");
  await expect(pr1).toHaveAttribute("data-status", "done");
  await expect(pr1.getByTestId("thread-agent-activity")).toHaveCount(0);
  // Ended, the row opens to its report and only that.
  await expect(pr1.getByTestId("thread-tool").first()).toHaveAttribute("aria-expanded", "false");
  await pr1.getByTestId("thread-tool").first().click();
  await expect(pr1.getByTestId("thread-agent-report")).toHaveText("Added task frame handling to the thread store with 14 table tests; make check is green.");
  await expect(pr1.locator("[data-tool]")).toHaveCount(0);
  await expect(notes).toHaveCount(2);
  const done = notes.last();
  await expect(done).not.toHaveAttribute("data-failed", "true");
  await expect(done.getByTestId("thread-agent-note-name")).toHaveText("PR 1: daemon task frames");
  await expect(done.getByTestId("thread-agent-note-summary")).toHaveText("Added task frame handling to the thread store with 14 table tests; make check is green.");
  await expect(done).toContainText("just now");
});

/** SHOTS=<dir>: the strip with background agents, WebKit, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`strip screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [state, name, text] of [["agents", "agents", "2 agents running in the background"]] as const) {
      await openThread(page, state);
      await expect(strip(page).getByTestId("agents-strip-count")).toHaveText(text);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${String(shots)}/strip-${name}-${scheme}.png` });
      await page.locator(".dock").first().screenshot({ path: `${String(shots)}/strip-${name}-${scheme}-dock.png` });
    }
  });
}
