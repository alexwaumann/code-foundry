import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * A worker's question its lead passed up to the user (docs/notes/pass-up-question.md). What each
 * piece shows and which verb the answer runs are vitest's (NeedsCard, PendingPrompt,
 * ShellSidebarList, lib/passUp, stores/lineage, mock/passUp); nothing here needs a browser beyond
 * what shell-needs.spec.ts and worker-card.spec.ts already cover, so this only saves the PR's
 * screenshots with SHOTS=<dir>, dark and light: the Needs you row and its hover card, the popup,
 * the docked card in the lead's pane with the worker card's line, and the pane after the answer;
 * and, for comparison, a lead's own question's card.
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

const rowOf = (page: Page, id: string) => page.locator(`[data-row-key="s:${id}"]`);

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: `${shots ?? ""}/${name}.png`, ...(clip ? { clip } : {}) });
}

for (const scheme of ["dark", "light"] as const) {
  test(`pass-up screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 860 });
    await mockPost("workers?state=passup");
    await mockPost("needs-you");
    await openApp(page);

    // Before: a lead's own question, as Needs you has always shown it.
    await rowOf(page, "s-ny-port").getByTestId("thread-name").hover();
    await expect(page.getByTestId("needs-card")).toContainText("Claude has a question");
    await shot(page, `pass-up-before-card-${scheme}`, { x: 0, y: 0, width: 800, height: 520 });
    await page.mouse.move(1270, 850);
    await expect(page.getByTestId("needs-card")).toHaveCount(0);

    // The lead's row, its line and its card.
    const lead = rowOf(page, "s-wl-lead");
    await expect(lead.getByTestId("needs-line")).toContainText("From Resize across collapsed panes:");
    await lead.getByTestId("thread-name").hover();
    await expect(page.getByTestId("needs-card-passed-up")).toBeVisible();
    await shot(page, `pass-up-row-card-${scheme}`, { x: 0, y: 0, width: 800, height: 520 });

    // The popup.
    await page.getByTestId("needs-card-open").click();
    const popup = page.getByTestId("needs-popup");
    await expect(popup.getByTestId("thread-question-passed-up")).toBeVisible();
    await shot(page, `pass-up-popup-${scheme}`);
    await page.getByTestId("needs-popup-close").click();
    await expect(popup).toHaveCount(0);

    // The lead's pane: the docked card and the worker's line.
    await openRowThread(page, "s-wl-lead");
    await expect(page.getByTestId("thread-question-passed-up")).toBeVisible();
    await expect(page.getByTestId("thread-workers")).toContainText("asks you");
    await shot(page, `pass-up-pane-${scheme}`);

    // Answered: the lead leaves Needs you, the worker works on, nothing new under the card.
    const other = page.getByTestId("thread-question").getByLabel("Other answer");
    await other.fill("The body too");
    await other.press("Enter");
    await expect(lead).not.toHaveAttribute("data-section", "needs");
    await expect(page.getByTestId("thread-workers")).not.toContainText("asks you");
    await page.mouse.move(1270, 850);
    await shot(page, `pass-up-after-${scheme}`);
  });
}
