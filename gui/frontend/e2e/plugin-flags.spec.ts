import { expect, test, type Page } from "@playwright/test";
import { expectAttention, mockPost, openApp, resetMock, row } from "./fixtures";

// Plugins' flags on threads (docs/notes/plugins-3-events-flags-env.md): a flagged thread
// needs attention (window title, sort), line 1 says the plugin's name in amber or red and line 3 the reason, and an
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

test("a flag puts the thread in the attention group with the plugin's name on line 1 and its reason on line 3; clearing it puts it back", async ({ page }) => {
  await openApp(page);
  await expectAttention(page, 1);

  await flag("s-3", "attention", "deploy needs approval");
  const s3 = row(page, "s:s-3");
  await expect(s3).toHaveAttribute("data-section", "attention");
  await expect(s3.getByTestId("row-status")).toHaveText("GitHub Actions");
  await expect(s3.getByTestId("row-status")).toHaveClass(/text-cf-warning-text/);
  await expect(s3.getByTestId("row-detail")).toHaveText("deploy needs approval");
  await expectAttention(page, 2);

  // A busy thread with an error flag leaves Working, in red.
  await flag("s-1", "error", "tests failed", "test-watcher", "Test Watcher");
  const s1 = row(page, "s:s-1");
  await expect(s1).toHaveAttribute("data-section", "attention");
  await expect(s1.getByTestId("row-status")).toHaveText("Test Watcher");
  await expect(s1.getByTestId("row-detail")).toHaveText("tests failed");
  await expect(s1.getByTestId("row-status")).toHaveClass(/text-cf-error-text/);
  await expectAttention(page, 3);
  await expect.poll(() => mainKeys(page)).toContain("s:s-1");

  await flag("s-3", "none", "");
  await expect(s3.getByTestId("row-status")).toHaveCount(0);
  await expectAttention(page, 2);
});

// An until-seen flag going when the thread is opened: the daemon's (internal/store/thread/flags_test.go, "until seen clears when the thread is opened…"); a flag's row status is src/components/sidebar/SidebarRow.test.tsx's.
