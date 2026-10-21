import { expect, test } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

// WebKit's fetch failure used to show as its bare "Load failed" under the composer.
test("sending while the daemon is unreachable says so and keeps the message", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  const composer = page.getByTestId("thread-composer");
  await composer.getByTestId("composer-input").click();
  await page.keyboard.type("hello while down");
  // The daemon goes away: every call fails in transport.
  await page.route("**/codefoundry.v1.*/**", (route) => route.abort("failed"));
  await page.keyboard.press("Enter");
  await expect(composer.getByTestId("thread-composer-error")).toHaveText("Code Foundry's daemon is not reachable; your message is kept. Retry when it is back.");
  await expect(composer.getByTestId("composer-input")).toContainText("hello while down");
});
