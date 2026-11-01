import { expect, test, type Page } from "@playwright/test";
import { composeProject, openApp, resetMock, row } from "./fixtures";

// The 2026-10-28 composer and shelf polish (docs/notes/composer-shelf-polish.md): title-case
// shelf headers with the count beside the chevron, the Claude mark in the Model pickers, a
// neutral send button while there is nothing to send, and placeholders that teach @ and /.

test.beforeEach(async () => {
  await resetMock();
});

// Shelf headers (title-case label, "Working 2"): src/components/sidebar/SidebarRow.test.tsx ("SidebarRow footer headers"). The count's pixel offset from the chevron is not tested.

// The new-thread composer's placeholder, semibold name, Claude mark colour, neutral send and Project folder's detail:
// unit-tested in src/components/compose/ComposerSend.test.tsx; the thread composer's idle and busy placeholders in
// src/components/thread/ThreadComposerDictation.test.tsx.

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await composeProject(page);
    await page.getByTestId("composer-worktree").click();
    await expect(page.getByTestId("composer-worktree-list")).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/new-thread-${scheme}.png` });
    await page.keyboard.press("Escape");
    await row(page, "s:s-6").click();
    await expect(page.getByTestId("thread-composer")).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/thread-idle-${scheme}.png` });
    await shot(page, `${String(shots)}/composer-idle-${scheme}.png`);
  });
}

async function shot(page: Page, path: string) {
  await page.getByTestId("thread-composer").screenshot({ path });
}
