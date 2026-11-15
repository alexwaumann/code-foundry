import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, openApp, openProjectPage, resetMock, row } from "./fixtures";

/**
 * Ignored files to include, in the GUI (docs/notes/file-search-2-includes-gui.md), for what
 * only the whole app shows: the project page's add field taking the keyboard inside the
 * page's listbox (its keys stay the field's), and the suggestions popover drawn over the
 * page below the field and inside the window. cmd+Enter in the finder through the real
 * keymap is e2e/file-finder.spec.ts's. The lists, restore, `none`, the
 * errors, the suggestions' contents and which call runs with which args are vitest's
 * (src/components/includes/, src/lib/includePatterns.test.ts). SHOTS=<dir> also saves the
 * PR's screenshots.
 */

const search = (page: Page) => page.getByTestId("project-search");
const addField = (page: Page) => search(page).getByTestId("include-add-input");

test.beforeEach(async () => {
  await resetMock();
});

test("the project page's add field keeps its keys: arrows pick a suggestion, Enter adds it for this project, cmd+Enter for all", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await addField(page).click();
  const pop = page.getByTestId("include-suggestions");
  await expect(pop).toBeVisible();
  // Over the page, below the field (it keeps room below itself, though it is the page's last thing), inside the window.
  const field = await addField(page).boundingBox();
  const box = await pop.boundingBox();
  const size = page.viewportSize();
  if (!field || !box || !size) throw new Error("not laid out");
  expect(box.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
  expect(box.y >= 0 && box.y + box.height <= size.height).toBe(true);
  await page.keyboard.type("scratch");
  await expect(pop.getByTestId("include-suggestion").first()).toHaveAttribute("data-path", "docs/scratch");
  await page.keyboard.press("ArrowDown");
  await expect(addField(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(search(page).locator('[data-testid="include-row"][data-pattern="docs/scratch/"]')).toHaveAttribute("data-scope", "project");

  await page.keyboard.type("*.log");
  await page.keyboard.press("Meta+Enter");
  await expect(search(page).locator('[data-testid="include-row"][data-pattern="*.log"]')).toHaveAttribute("data-scope", "all");
  await expect(addField(page)).toBeFocused();
  await expect(addField(page)).toHaveValue("");
});

const shots = process.env.SHOTS;

/** Screenshots for the PR (both schemes), on the tree as it is: run before and after the change. */
test("include screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = async (name: string, target: () => Locator, ready: () => Promise<void> = () => Promise.resolve()) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await ready();
      await target().screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openApp(page);

  // Settings › General › Files.
  await page.keyboard.press("Meta+Comma");
  const settings = page.getByTestId("settings-page");
  await expect(settings.locator("[data-setting]").first()).toBeVisible();
  const section = settings.locator('[data-testid="settings-section"][data-section="files"]');
  await section.scrollIntoViewIfNeeded();
  await shot("settings-files", () => settings, () => section.evaluate((el) => { el.scrollIntoView({ block: "center" }); }));
  const remove = section.locator('[data-testid="include-row"][data-pattern="CLAUDE.local.md"] [data-testid="include-remove"]');
  if ((await remove.count()) > 0) {
    await remove.click();
    const add = section.getByTestId("include-add-input");
    await add.fill("scratch/");
    await add.press("Enter");
    await expect(section.getByTestId("include-restore")).toHaveText("Restore 1 default");
    await shot("settings-files-edited", () => settings, () => section.evaluate((el) => { el.scrollIntoView({ block: "center" }); }));
  }
  // A field keeps the first Escape (it lets go); the next closes the sheet.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  // The project page.
  await openProjectPage(page, "repo-cf");
  const pagePane = () => page.getByTestId("shell-pane").filter({ has: page.getByTestId("projects-page") });
  if ((await search(page).count()) > 0) {
    await addField(page).click();
    await page.keyboard.type("d");
    await expect(page.getByTestId("include-suggestion").first()).toBeVisible();
    await shot("project-search", pagePane, () => search(page).evaluate((el) => { el.scrollIntoView({ block: "start" }); }));
    await page.keyboard.press("Escape");
  } else {
    await shot("project-search", pagePane, () => page.getByTestId("projects-scroll").evaluate((el) => { el.scrollTo({ top: el.scrollHeight }); }));
  }

  // cmd+P over a thread.
  await mockPost(`files?project=repo-cf&${["README.md", "src/env.ts", "src/app.ts", "docs/environment.md"].map((f) => `path=${encodeURIComponent(f)}`).join("&")}`);
  await mockPost("ignored?project=repo-cf&path=.env&path=.env.local&path=src/.env.test");
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+p");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "files");
  await page.keyboard.type("env");
  await expect(palette.getByTestId("finder-row").first()).toBeVisible();
  await shot("finder-env", () => palette);
});
