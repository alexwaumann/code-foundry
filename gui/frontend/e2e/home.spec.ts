import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, openApp, resetMock, row } from "./fixtures";

// The window's home is the new-thread composer on No project, its project picker closed
// (docs/notes/remove-dashboard.md): where the window opens, and where it goes when its
// selection goes away.

test.beforeEach(async () => {
  await resetMock();
});

const composer = (page: Page) => page.getByTestId("composer");

async function expectHome(page: Page, heading = "What should we build with No project?"): Promise<void> {
  await expect(composer(page)).toBeVisible();
  await expect(page.getByTestId("composer-heading")).toHaveText(heading);
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-project-list")).toHaveCount(0);
}

test("no projects: the No project composer, as the welcome; New thread's picker offers Add a project", async ({ page }) => {
  await mockPost("empty");
  await page.goto(appPath);
  // The first-run welcome (e2e/welcome-composer.spec.ts).
  await expectHome(page, "Welcome to Code Foundry");
  // The sidebar's thread list is simply empty: no placeholder text.
  await expect(page.getByTestId("thread-list")).toHaveText("");
  await expect(page.getByTestId("thread-list-empty")).toHaveCount(0);
  await expect(page.getByTestId("backdrop")).toHaveCount(1);

  await page.getByTestId("sidebar-new-thread").click();
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await expect(page.getByTestId("picker-add-project")).toBeVisible();
});

test("with projects: the window opens on the No project composer, picker closed and nothing typed", async ({ page }) => {
  await openApp(page);
  await expectHome(page);
  await expect(page.getByTestId("composer-input")).toHaveText("");
  // Escape with nothing typed stays home.
  await page.getByTestId("composer-input").click();
  await page.keyboard.press("Escape");
  await expectHome(page);
  // The user closing the heading's picker stays on the composer too.
  await page.getByTestId("composer-project-trigger").click();
  await expect(page.getByTestId("composer-project-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expectHome(page);
});

test("cmd+[ never goes past home: back from a thread lands on the composer, and again stays there", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(composer(page)).toHaveCount(0);
  await page.getByTestId("sidebar-menu").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Meta+BracketLeft");
  await expectHome(page);
  // Out of the composer's prompt (a text field keeps cmd+[ to itself).
  await page.getByTestId("sidebar-menu").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Meta+BracketLeft");
  await expectHome(page);
});

// The backdrop (custom, none, a missing file): unit-tested in src/components/backdrop/Backdrop.test.tsx
