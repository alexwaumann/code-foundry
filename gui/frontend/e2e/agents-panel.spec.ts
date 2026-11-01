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

test.beforeEach(async () => {
  await resetMock();
});

// The strip's count, kind and run names as runs end, and the row's badge: unit-tested in
// src/components/thread/AgentsStrip.test.tsx and src/components/sidebar/SidebarRow.test.tsx.

// Background shells only: no strip (AgentsStrip.test.tsx "leaves background shells to the thread
// info card"), the sidebar's shell badge and no agents one (SidebarRow.test.tsx), and the calls
// running until the daemon ends their shell (agentRows.test.tsx "a background shell's call").
// The timeline's background and failed chips, live activity, the failed run's note in the folded
// turn, a run ending (done, its report only, a finished note): unit-tested in
// src/components/thread/agentRows.test.tsx.

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
