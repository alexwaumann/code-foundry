import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

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

// No projects: the welcome heading (src/components/compose/Composer.test.tsx), the thread list simply
// empty (src/components/sidebar/Sidebar.test.tsx "empty once loaded"), New thread opening the project
// picker (src/keys/bindings.test.ts "thread.new's chord opens the project picker") with Add a project
// pinned and highlighted (src/components/compose/ProjectPicker.test.tsx "with no projects yet"). The
// composer renders the one <Backdrop /> (src/components/backdrop/Backdrop.test.tsx).

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

// "cmd+[ never goes past home: back from a thread lands on the composer, and again stays there": the
// classic selection history is gone. In the window shell cmd+[ and cmd+] step through what was
// focused, across panes and spaces (e2e/shell-spaces.spec.ts "back and forward go through the focus
// across panes and spaces"; src/stores/focusHistory.test.ts), and a thread opened on the first
// load's empty space replaces it, leaving no composer to go back to.

// The backdrop (custom, none, a missing file): unit-tested in src/components/backdrop/Backdrop.test.tsx
