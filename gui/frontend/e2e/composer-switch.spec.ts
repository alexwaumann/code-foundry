import { expect, test, type Page } from "@playwright/test";
import { composeProject, openApp, resetMock } from "./fixtures";

/**
 * The composer heading's set picker (docs/notes/workspaces-v2-3-composer.md): a
 * multi-select over the project rows; "No project" moves the draft. The project set itself
 * (chips, primary, workspaces) is project-sets.spec.ts.
 */

test.beforeEach(async () => {
  await resetMock();
});

/** cmd+n, then the nth project row of the picker: that project's composer. */
async function compose(page: Page, n = 1): Promise<void> {
  await composeProject(page, n);
}

const heading = (page: Page) => page.getByTestId("composer-heading");
const trigger = (page: Page) => page.getByTestId("composer-project-trigger");
const list = (page: Page) => page.getByTestId("composer-project-list");
/** The prompt as the draft stores it. */
const prompt = (page: Page) => page.getByTestId("composer-prompt");

// The trigger's name and popup, the rows (no headings, no hints, the source line), the current target checked, a
// project row as the whole set with the draft kept, and thread.new's args: unit-tested in
// src/components/compose/ComposerSets.test.tsx. What stays: where the list sits, the dotted underline, and focus.
test("the heading's picker: centred under the name; a project row closes it and the prompt takes focus", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await trigger(page).click();
  await expect(list(page)).toBeVisible();
  await expect(page.getByPlaceholder("Switch to a workspace or project…")).toBeFocused();
  // Centred under the name, just below it; the dotted underline is the name's own border.
  const name = page.getByTestId("composer-project-name");
  await expect(name).toHaveCSS("border-bottom-style", "dotted");
  await expect(trigger(page)).toHaveCSS("border-bottom-width", "0px");
  await expect
    .poll(async () => {
      const [n, l] = await Promise.all([name.boundingBox(), list(page).boundingBox()]);
      if (!n || !l) return null;
      return { centre: Math.round(Math.abs(n.x + n.width / 2 - (l.x + l.width / 2))) <= 1, gap: Math.round(l.y - (n.y + n.height)) };
    })
    .toEqual({ centre: true, gap: 8 });
  await page.keyboard.type("ghostty");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(heading(page)).toHaveText("What should we build in ghostty-playground?");
});

test("the trigger is a Tab stop before the chips; Enter/Space open it, Esc closes it and the prompt takes focus", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await page.keyboard.type("Keep me");

  // Prompt ← the collision banner's "Use a new branch" (s-1 runs in code-foundry's folder) ← Add project ← the heading's name.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("composer-collision-new-branch")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("composer-add-project")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(trigger(page)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Switch to a workspace or project…")).toBeFocused();
  await page.keyboard.type("dot");
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");

  // Space opens it too, unfiltered again; a click away closes it onto the prompt as well.
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Tab");
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByPlaceholder("Switch to a workspace or project…")).toHaveValue("");
  await page.getByTestId("composer-heading").click({ position: { x: 4, y: 4 } });
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Keep me");
});

// No project moving the draft and a project row moving it back: unit-tested in src/components/compose/ComposerSets.test.tsx.

test("taking a project out drops its skill tags after a confirm; the rest stays", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await page.getByTestId("composer-input").click();
  // code-foundry's /deploy, sketches' /deploy (second in the card), the user's /commit.
  await page.keyboard.type("/deploy");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/deploy");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/commit");
  await page.keyboard.press("Enter");
  const CF = "[/deploy](cf-skill://repo-cf/deploy)";
  const SK = "[/deploy](cf-skill://repo-sk/deploy)";
  const USER = "[/commit](cf-skill://~/commit)";
  await expect(prompt(page)).toHaveAttribute("data-value", `${CF} ${SK} ${USER} `);

  // The confirm's wording and Cancel: unit-tested in src/components/compose/ComposerSets.test.tsx.
  await page.getByRole("button", { name: "Remove code-foundry" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(heading(page)).toHaveText("What should we build in sketches?");
  // sketches stays, so its tag stays; the user's skill always does.
  await expect(prompt(page)).toHaveAttribute("data-value", `${SK} ${USER}`);
  await expect(page.getByTestId("prompt-tag")).toHaveText(["/deploy", "/commit"]);
});
