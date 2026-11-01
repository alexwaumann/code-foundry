import { expect, test, type Page } from "@playwright/test";
import { composeProject, openApp, resetMock, row, threadPrompt } from "./fixtures";

// The 2026-10-28 composer and shelf polish (docs/notes/composer-shelf-polish.md): title-case
// shelf headers with the count beside the chevron, the Claude mark in the Model pickers, a
// neutral send button while there is nothing to send, and placeholders that teach @ and /.

test.beforeEach(async () => {
  await resetMock();
});

// Shelf headers (title-case label, "Working 2"): src/components/sidebar/SidebarRow.test.tsx ("SidebarRow footer headers"). The count's pixel offset from the chevron is not tested.

test("new thread composer: placeholder, Claude mark, neutral send, project folder detail", async ({ page }) => {
  await openApp(page);
  await composeProject(page);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("aria-placeholder", "Ask anything. @ files and threads, / skills and commands");
  await expect(page.getByTestId("composer-heading").getByTestId("composer-project-name")).toHaveCSS("font-weight", "600");
  await expect(page.getByTestId("composer-model").locator("svg").first()).toHaveCSS("color", "rgb(217, 119, 87)");
  const send = page.getByTestId("composer-send");
  await expect(send).toBeDisabled();
  const idle = await send.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId("composer-input").pressSequentially("Hello");
  await expect(send).toBeEnabled();
  const ready = await send.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ready).not.toBe(idle);
  await page.getByTestId("composer-worktree").click();
  await expect(page.getByTestId("composer-worktree-list").getByRole("option").filter({ hasText: "Project folder" })).toContainText(
    "Edits land in the project's checkout directly. One thread at a time is safest.",
  );
});

test("thread composer: placeholders idle and busy", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-6").click();
  await expect(threadPrompt(page)).toHaveAttribute("aria-placeholder", "Reply or ask anything. @ files and threads, / skills and commands");
  await expect(page.getByTestId("thread-send")).toBeDisabled();
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toHaveAttribute("aria-placeholder", "Steer the agent mid-turn. @ files and threads, / skills and commands");
});

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
