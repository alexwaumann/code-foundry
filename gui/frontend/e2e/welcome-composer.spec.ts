import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, openAddProjectDialog, projectAt, resetMock } from "./fixtures";

// The first-run welcome on the home composer (docs/notes/welcome-composer.md): with zero
// projects the No project composer greets and prefills, never sends, the tutorial prompt
// naming the page the daemon placed (the mock's HealthService.Version says where).

test.beforeEach(async () => {
  await resetMock();
  await mockPost("empty");
});

const PAGE = "/Users/dev/.code-foundry/pages/welcome.html";
const PROMPT = `I just installed Code Foundry and have no projects yet. This is the welcome tutorial: open the page ${PAGE} in the side panel and walk me through it.`;

const heading = (page: Page) => page.getByTestId("composer-heading");
const prompt = (page: Page) => page.getByTestId("composer-prompt");

async function openWelcome(page: Page): Promise<void> {
  await page.goto(appPath);
  await expect(heading(page)).toHaveText("Welcome to Code Foundry");
  await expect(page.getByTestId("composer-project-trigger")).toHaveCount(0);
  await expect(prompt(page)).toHaveAttribute("data-value", PROMPT);
  await expect(page.getByTestId("composer-input")).toHaveText(PROMPT);
}

// Zero projects: the Welcome heading and the prefilled prompt, not sent; Enter sending it as a No project
// thread's first message: unit-tested in src/components/compose/Composer.test.tsx.

/** Adds ~/src/new-app through the Local folder tab, then steps back to home (cmd+[). */
async function addFirstProject(page: Page): Promise<void> {
  await openAddProjectDialog(page);
  await page.getByTestId("add-project-local-input").fill("src/new-app");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-dialog")).toHaveCount(0);
  expect(await projectAt("/Users/dev/src/new-app")).toMatchObject({ name: "new-app" });
  await page.getByTestId("sidebar-menu").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Meta+BracketLeft");
  await expect(page.getByTestId("composer")).toBeVisible();
}

// The first project reverting the heading and clearing an untouched prompt: src/components/compose/Composer.test.tsx ("the first project clears an untouched prefill, and the heading reverts"); the editor showing the draft is the next test.

// The edited prompt staying when the first project arrives: unit-tested in src/components/compose/Composer.test.tsx.
// What stays: the real editor's focus and caret after the prefilled text.
test("the welcome prompt has focus, the caret after the prefilled text: typing appends", async ({ page }) => {
  await openWelcome(page);
  // The prompt has focus and the caret is after the prefilled text: typing appends.
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type(" Slowly.");
  await expect(prompt(page)).toHaveAttribute("data-value", `${PROMPT} Slowly.`);
});
