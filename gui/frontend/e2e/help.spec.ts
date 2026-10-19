import { expect, test } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

// Tabs, contents and close are unit-tested (src/components/help/HelpOverlay.test.tsx); this
// keeps what needs the browser: cmd+/, a real scroll, and the daemon's keybindings.
test("help overlay: the guide first, its contents scroll it, then the shortcuts", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Slash");
  const help = page.getByTestId("help-overlay");
  await expect(help).toBeVisible();
  await expect(page.getByTestId("help-tab-guide")).toHaveAttribute("data-state", "active");

  // A contents entry scrolls the guide to its heading.
  const settings = page.getByTestId("help-guide").getByRole("heading", { level: 2, name: "Settings" });
  await expect(settings).not.toBeInViewport();
  await page.getByTestId("help-toc").getByRole("button", { name: "Settings" }).click();
  await expect(settings).toBeInViewport();

  await page.getByTestId("help-tab-shortcuts").click();
  await expect(help.locator('[data-help-command="thread.new"]')).toContainText("⌘N");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});
