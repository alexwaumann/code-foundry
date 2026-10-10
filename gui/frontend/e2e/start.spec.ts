import { expect, test, type Page } from "@playwright/test";
import { appPath, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

const start = (page: Page) => page.getByTestId("start-page");

/** A steady fleet: s-1 (which flips busy/idle) and the settling s-5/s-6 disconnected, s-2 waiting. */
async function steadyFleet(): Promise<void> {
  for (const id of ["s-1", "s-5", "s-6"]) await mockPost(`session/disconnect?id=${id}&reason=closed&code=0`);
}

test("onboarding: no projects shows the welcome and Add a project", async ({ page }) => {
  await mockPost("empty");
  await page.goto(appPath);
  await expect(start(page)).toHaveAttribute("data-state", "onboarding");
  await expect(page.getByTestId("start-heading")).toHaveText("Welcome to Code Foundry");
  // The sidebar's thread list is simply empty: no placeholder text.
  await expect(page.getByTestId("thread-list")).toHaveText("");
  await expect(page.getByTestId("thread-list-empty")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-steps")).toHaveCount(0);
  await expect(page.getByTestId("backdrop")).toHaveCount(1);

  // Add a project is repo.add: the Add Project dialog, on Local folder with the path focused.
  await page.getByTestId("welcome-actions").getByRole("button", { name: "Add a project" }).click();
  await expect(page.getByTestId("add-project-dialog")).toBeVisible();
  await expect(page.getByTestId("add-project-dialog")).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name.startsWith("repo."))).toEqual([]);
});

test("with projects: greeting, counts, actions, and no New terminal", async ({ page }) => {
  await steadyFleet();
  await mockPost("threads?repo=repo-cf&count=2&status=busy&prefix=Job");
  await openApp(page);
  await expect(start(page)).toHaveAttribute("data-state", "fleet");
  await expect(page.getByTestId("start-heading")).toHaveText(/^Good (morning|afternoon|evening)$/);
  await expect(page.getByTestId("start-counts")).toHaveText("3 connected · 2 running · 1 waiting on you");
  await expect(page.getByTestId("start-waiting")).toHaveClass(/amber/);
  const actions = page.getByTestId("welcome-actions");
  await expect(actions.getByRole("button")).toHaveText(["New thread", "Command palette"]);
  await expect(start(page).getByRole("button", { name: "New terminal" })).toHaveCount(0);

  // Nothing waiting: the count is muted.
  await mockPost("session/status?id=s-2&status=idle");
  await expect(page.getByTestId("start-counts")).toHaveText("3 connected · 2 running · 0 waiting on you");
  await expect(page.getByTestId("start-waiting")).not.toHaveClass(/amber/);

  await start(page).getByRole("button", { name: "Keyboard Shortcuts" }).click();
  await expect(page.getByTestId("help-overlay")).toBeVisible();
});

test("thread list: waiting first, capped at six, a row selects its thread", async ({ page }) => {
  await steadyFleet();
  await mockPost("threads?repo=repo-cf&count=4&status=busy&prefix=Job");
  await mockPost("threads?repo=repo-dot&count=3&status=attention&prefix=Ask");
  await mockPost("threads?repo=repo-cf&count=2&status=idle&prefix=Idle");
  await openApp(page);
  await expect(page.getByTestId("start-counts")).toHaveText("10 connected · 4 running · 4 waiting on you");
  const rows = page.getByTestId("start-threads").locator("[data-session-link]");
  await expect(rows).toHaveCount(6);
  await expect(page.getByTestId("start-threads-more")).toHaveText("+2 more");
  await expect(rows.nth(0)).toContainText("Port renderer");
  await expect(rows.nth(0)).toContainText("waiting · ghostty-playground");
  await expect(rows.nth(1)).toContainText("waiting · dotfiles");
  await expect(rows.nth(4)).toContainText("running · code-foundry");
  await expect(page.getByTestId("start-threads")).not.toContainText("Idle");

  await rows.nth(0).click();
  await expect(start(page)).toHaveCount(0);
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
});

test("thread list hides when nothing is running or waiting", async ({ page }) => {
  await steadyFleet();
  await mockPost("session/status?id=s-2&status=idle");
  await openApp(page);
  await expect(page.getByTestId("start-counts")).toHaveText("1 connected · 0 running · 0 waiting on you");
  await expect(page.getByTestId("start-threads")).toHaveCount(0);
});

test("appearance.backdrop none removes the artwork from the start page and the composer", async ({ page }) => {
  await openApp(page);
  await expect(start(page).locator("..").getByTestId("backdrop")).toHaveAttribute("data-backdrop", "forest");
  await page.getByTestId("welcome-actions").getByRole("button", { name: "New thread" }).click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("backdrop")).toHaveCount(1);
  await mockPost("settings/external?appearance.backdrop=none");
  await expect(page.getByTestId("backdrop")).toHaveCount(0);
});
