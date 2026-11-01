import { expect, test, type Page } from "@playwright/test";
import { invocations, openApp, resetMock, row } from "./fixtures";

/**
 * Settings → Skills (docs/notes/skills-4-gui.md) against the mock's ai-marketplace
 * (mock/skills.ts): secure-coding and enterprise-data (1.3.2, Update to 1.4.0) installed
 * plugins, pr-review (enabled), sql-helper (disabled), jira-sync (needs setup),
 * incident-postmortem (an update) and the local my-notes.
 */

/** Settings → Skills; with `thread`, that thread selected first (skill.setup's owner). */
async function openSkills(page: Page, thread?: string): Promise<void> {
  await openApp(page);
  if (thread) await row(page, thread).click();
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-skills").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "skills");
  await expect(installed(page, "pr-review")).toBeVisible();
}

const installed = (page: Page, name: string, kind = "skill") => page.locator(`[data-testid="skill-installed-row"][data-name="${name}"][data-kind="${kind}"]`);

test.beforeEach(async () => {
  await resetMock();
});

// The Installed and Browse rows, search and chips, install and its failure, the confirm,
// Run setup's tooltip and Registries: unit-tested in
// src/components/skill/settings/SkillsPage.test.tsx (the search's ranking and filters in
// internal/store/skill/marketplace/search_test.go).

test("Run setup with a thread selected runs skill.setup and reveals its bottom panel", async ({ page }) => {
  await openSkills(page, "s:s-3");
  const setup = installed(page, "jira-sync").getByTestId("skill-setup");
  await expect(setup).toBeEnabled();
  await setup.click();
  // The panel is the thread's: Settings closes for it.
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect.poll(async () => (await invocations()).some((c) => c.name === "skill.setup" && c.args.name === "jira-sync")).toBe(true);
});

test("the settings search finds the Skills page's sections and opens the page there", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("skills registries");
  await expect(page.getByTestId("settings-section-hit")).toHaveText(["Skills › RegistriesThe marketplaces Claude Code knows about, and refreshing them."]);
  await expect(page.getByTestId("settings-nav-skills").getByTestId("settings-nav-count")).toHaveText("1");
  await page.getByTestId("settings-section-hit").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "skills");
  await expect(page.locator('[data-section="registries"]')).toBeInViewport();
});
