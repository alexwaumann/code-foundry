import { expect, test } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

/**
 * Settings → Skills (docs/notes/skills-4-gui.md) against the mock's ai-marketplace
 * (mock/skills.ts): secure-coding and enterprise-data (1.3.2, Update to 1.4.0) installed
 * plugins, pr-review (enabled), sql-helper (disabled), jira-sync (needs setup),
 * incident-postmortem (an update) and the local my-notes.
 */

test.beforeEach(async () => {
  await resetMock();
});

// The Installed and Browse rows, search and chips, install and its failure, the confirm,
// Run setup's tooltip and Registries: unit-tested in
// src/components/skill/settings/SkillsPage.test.tsx (the search's ranking and filters in
// internal/store/skill/marketplace/search_test.go).

// Run setup with a thread selected: the button runs skill.setup with reveal
// (src/components/skill/settings/SkillsPage.test.tsx), which runs it in the thread's context
// and reveals the terminal (src/stores/skill.test.ts); a revealed shell closes Settings
// (src/stores/bottomActions.test.ts "revealShell").

// The hit's text and the nav's count: src/components/settings/SettingsPage.test.tsx (search).
test("the settings search's Skills › Registries hit scrolls that section into view", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("skills registries");
  await page.getByTestId("settings-section-hit").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "skills");
  await expect(page.locator('[data-section="registries"]')).toBeInViewport();
});
