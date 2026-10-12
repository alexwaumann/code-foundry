import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

/** cmd+n, then cmd+1: the composer for code-foundry. */
async function compose(page: Page): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/** sessions.render as if the settings file changed (the settings stream applies it live). */
async function setView(view: "terminal" | "rendered"): Promise<void> {
  await mockPost(`settings/external?sessions.render=${view}`);
}

async function lastNew() {
  const last = (await invocations()).filter((i) => i.name === "session.new").at(-1);
  return last?.args ?? {};
}

test("the View picker starts at the setting and follows it until picked", async ({ page }) => {
  await openApp(page);
  await compose(page);
  const view = page.getByTestId("composer-render");
  await expect(view).toHaveText("Terminal");
  await expect(view).toHaveAccessibleName("View: Terminal");

  // An untouched draft follows the setting, both ways.
  await setView("rendered");
  await expect(view).toHaveText("Rendered");
  await setView("terminal");
  await expect(view).toHaveText("Terminal");

  // The list: both views with their hint, a checkmark on the current one.
  await view.click();
  const options = page.getByTestId("composer-render-list").getByRole("option");
  await expect(options).toHaveText([/^Terminal\s*Claude Code's own interface/, /^Rendered\s*The app draws the conversation/]);
  await options.nth(1).click();
  await expect(view).toHaveText("Rendered");
  await expect(view).toBeFocused();

  // Picked: the setting no longer moves it.
  await setView("terminal");
  await setView("rendered");
  await setView("terminal");
  await expect(view).toHaveText("Rendered");
});

test("Enter starts the thread in the picked view: rendered opens the thread pane", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.getByTestId("composer-render").click();
  await page.getByTestId("composer-render-list").getByRole("option", { name: /^Rendered/ }).click();
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Summarize the README");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  // No items until Claude is up: the timeline says it is starting.
  await expect(page.getByTestId("thread-working")).toHaveText("Starting Claude…");
  expect(await lastNew()).toMatchObject({ repo: "repo-cf", prompt: "Summarize the README", render: "rendered" });
  // The header says how the thread runs; the first message goes out once Claude is up.
  await expect(page.getByTestId("session-render")).toHaveText("rendered");
  await expect(page.getByTestId("thread-user").first()).toContainText("Summarize the README", { timeout: 8000 });
  await expect(page.getByTestId("thread-footer")).toHaveCount(1, { timeout: 8000 });
});

test("with the setting at Rendered, an explicit Terminal wins", async ({ page }) => {
  await setView("rendered");
  await openApp(page);
  await compose(page);
  const view = page.getByTestId("composer-render");
  await expect(view).toHaveText("Rendered");
  await view.click();
  await page.getByTestId("composer-render-list").getByRole("option", { name: /^Terminal/ }).click();
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Fix the flaky test");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect(page.getByTestId("session-render")).toHaveCount(0);
  expect(await lastNew()).toMatchObject({ prompt: "Fix the flaky test", render: "terminal" });
});

test("an untouched draft sends the setting's view", async ({ page }) => {
  await setView("rendered");
  await openApp(page);
  await compose(page);
  await expect(page.getByTestId("composer-render")).toHaveText("Rendered");
  await page.keyboard.type("Explain the build");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  expect(await lastNew()).toMatchObject({ render: "rendered" });
});
