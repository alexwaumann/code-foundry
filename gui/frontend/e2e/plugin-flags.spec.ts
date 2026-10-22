import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

// Plugins' flags on threads (docs/notes/plugins-3-events-flags-env.md): a flagged thread
// needs attention (bell, sort), line 2 says "<plugin>: <reason>" in amber or red, and an
// until-seen flag goes when the thread is opened. The mock's POST /__mock/thread/flag is a
// plugin's thread/setFlag.

test.beforeEach(async () => {
  await resetMock();
});

function mainKeys(page: Page): Promise<string[]> {
  return page
    .getByTestId("sidebar-main")
    .locator("[data-row-key]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key") ?? ""));
}

const flag = (id: string, level: string, reason: string, plugin = "gh-actions", name = "GitHub Actions", untilSeen = false) =>
  mockPost(
    `thread/flag?id=${id}&plugin=${plugin}&name=${encodeURIComponent(name)}&level=${level}&reason=${encodeURIComponent(reason)}${untilSeen ? "&untilSeen=1" : ""}`,
  );

test("a flag puts the thread in the attention group with the plugin's reason on line 2; clearing it puts it back", async ({ page }) => {
  await openApp(page);
  const bell = page.getByTestId("sidebar-notifications").getByTestId("attention-badge");
  await expect(bell).toHaveText("1");

  await flag("s-3", "attention", "deploy needs approval");
  const s3 = row(page, "s:s-3");
  await expect(s3).toHaveAttribute("data-section", "attention");
  await expect(s3.getByTestId("row-status")).toHaveText("GitHub Actions: deploy needs approval");
  await expect(s3.getByTestId("row-status")).toHaveClass(/text-cf-warning/);
  await expect(bell).toHaveText("2");

  // A busy thread with an error flag leaves Working, in red.
  await flag("s-1", "error", "tests failed", "test-watcher", "Test Watcher");
  const s1 = row(page, "s:s-1");
  await expect(s1).toHaveAttribute("data-section", "attention");
  await expect(s1.getByTestId("row-status")).toHaveText("Test Watcher: tests failed");
  await expect(s1.getByTestId("row-status")).toHaveClass(/text-cf-error/);
  await expect(bell).toHaveText("3");
  await expect.poll(() => mainKeys(page)).toContain("s:s-1");

  await flag("s-3", "none", "");
  await expect(s3.getByTestId("row-status")).toHaveCount(0);
  await expect(bell).toHaveText("2");
});

test("an until-seen flag goes when the thread is opened", async ({ page }) => {
  await openApp(page);
  await flag("s-3", "attention", "new run failed", "gh-actions", "GitHub Actions", true);
  const s3 = row(page, "s:s-3");
  await expect(s3.getByTestId("row-status")).toHaveText("GitHub Actions: new run failed");
  await s3.click();
  await expect(s3.getByTestId("row-status")).toHaveCount(0);
});
