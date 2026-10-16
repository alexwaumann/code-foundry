import { expect, test } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

test("help overlay: the guide first, its contents scroll it, then the shortcuts", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Slash");
  const help = page.getByTestId("help-overlay");
  await expect(help).toBeVisible();

  // The Guide tab is the default: docs/GETTING-STARTED.md from its first section.
  await expect(page.getByTestId("help-tab-guide")).toHaveAttribute("data-state", "active");
  const guide = page.getByTestId("help-guide");
  await expect(guide.getByRole("heading", { level: 2 }).first()).toHaveText("Getting started");
  await expect(guide).toContainText("A single surface for all your agents.");
  await expect(guide.locator("kbd", { hasText: "⌘N" })).toBeVisible();

  // A contents entry scrolls the guide to its heading.
  const settings = guide.getByRole("heading", { level: 2, name: "Settings" });
  await expect(settings).not.toBeInViewport();
  await page.getByTestId("help-toc").getByRole("button", { name: "Settings" }).click();
  await expect(settings).toBeInViewport();

  await page.getByTestId("help-tab-shortcuts").click();
  await expect(page.getByTestId("help-tab-shortcuts")).toHaveAttribute("data-state", "active");
  await expect(guide).toHaveCount(0);
  await expect(help.locator('[data-help-command="thread.new"]')).toContainText("⌘N");

  // Closed and opened again with cmd+/: back on the guide.
  await page.getByTestId("help-close").click();
  await expect(help).toHaveCount(0);
  await page.keyboard.press("Meta+Slash");
  await expect(page.getByTestId("help-tab-guide")).toHaveAttribute("data-state", "active");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);

  // The start page's Keyboard Shortcuts link lands on the shortcuts tab.
  await page.getByTestId("start-page").getByRole("button", { name: "Keyboard Shortcuts" }).click();
  await expect(page.getByTestId("help-tab-shortcuts")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("help-shortcuts")).toBeVisible();
});
