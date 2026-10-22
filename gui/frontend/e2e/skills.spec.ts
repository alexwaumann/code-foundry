import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Settings → Skills (docs/notes/skills-4-gui.md) against the mock's ai-marketplace
 * (mock/skills.ts): secure-coding and enterprise-data (1.3.2, Update to 1.4.0) installed
 * plugins, pr-review (enabled), sql-helper (disabled), jira-sync (needs setup),
 * incident-postmortem (an update) and the local my-notes.
 */

const RESTART = "Threads that are running keep it until they restart. New threads pick this up at once.";

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
const entry = (page: Page, name: string, kind = "skill") => page.locator(`[data-testid="skill-entry"][data-name="${name}"][data-kind="${kind}"]`);
const search = (page: Page) => page.getByTestId("skill-search");

test.beforeEach(async () => {
  await resetMock();
});

test("Installed shows each row's kind, source, version and state, and only the actions it has", async ({ page }) => {
  await openSkills(page);
  await expect(page.getByTestId("skill-installed-row")).toHaveCount(7);

  const pr = installed(page, "pr-review");
  await expect(pr.getByTestId("skill-kind")).toHaveText("Skill");
  await expect(pr.getByTestId("skill-state")).toHaveText("Enabled");
  await expect(pr.getByTestId("skill-source")).toHaveText("from ai-marketplace · by Code Quality Guild");
  await expect(pr.getByTestId("skill-version")).toContainText("20260912 · ");
  await expect(pr.getByRole("button")).toHaveText(["Disable", "Uninstall"]);

  await expect(installed(page, "sql-helper").getByTestId("skill-state")).toHaveText("Disabled");
  await expect(installed(page, "sql-helper").getByRole("button")).toHaveText(["Enable", "Uninstall"]);
  await expect(installed(page, "jira-sync").getByTestId("skill-state")).toHaveText("Needs setup");
  await expect(installed(page, "jira-sync").getByRole("button")).toHaveText(["Disable", "Run setup", "Uninstall"]);
  await expect(installed(page, "incident-postmortem").getByTestId("skill-update")).toHaveText("Update to 20261016");

  // A local skill: Local, no state, Remove only.
  const local = installed(page, "my-notes");
  await expect(local.getByTestId("skill-source")).toHaveText("Local");
  await expect(local.getByTestId("skill-state")).toHaveCount(0);
  await expect(local.getByRole("button")).toHaveText(["Remove"]);

  // A plugin: its version, the offer, and its skills behind "N skills".
  const data = installed(page, "enterprise-data", "plugin");
  await expect(data.getByTestId("skill-kind")).toHaveText("Plugin");
  await expect(data.getByTestId("skill-version")).toHaveText("1.3.2");
  await expect(data.getByTestId("skill-update")).toHaveText("Update to 1.4.0");
  await expect(data.getByTestId("skill-plugin-skill-list")).toHaveCount(0);
  await data.getByTestId("skill-plugin-skills").click();
  await expect(data.getByTestId("skill-plugin-skill-list").locator("li")).toHaveText(["catalog", "data-quality", "lineage", "query-warehouse"]);

  // An update runs skill.update with the kind; the row loses the offer.
  await installed(page, "incident-postmortem").getByTestId("skill-update").click();
  await expect(installed(page, "incident-postmortem").getByTestId("skill-update")).toHaveCount(0);
  expect((await invocations()).some((c) => c.name === "skill.update" && c.args.name === "incident-postmortem" && c.args.kind === "skill")).toBe(true);
});

test("Browse searches as you type, the chips filter, and the count says how many", async ({ page }) => {
  await openSkills(page);
  // Empty query: everything by name (42), virtualised.
  await expect(page.getByTestId("skill-results")).toHaveText("42 results");
  await expect(page.getByTestId("skill-entries")).toHaveAttribute("data-virtual", "true");

  await search(page).fill("sql");
  await expect(page.getByTestId("skill-results")).toHaveText("4 results");
  // Name hits first.
  await expect(page.getByTestId("skill-entry").first()).toHaveAttribute("data-name", "sql-formatter");
  const helper = entry(page, "sql-helper");
  await expect(helper.getByTestId("skill-tier")).toHaveText("Enterprise");
  await expect(helper.getByTestId("skill-by")).toHaveText("by Jane Doe");
  await expect(helper.getByTestId("skill-keywords")).toHaveText("sql · postgres");
  await expect(helper.getByTestId("skill-installed-mark")).toHaveText("Installed, disabled");

  // Community only, then Plugin too (nothing), then Plugin alone.
  await page.getByTestId("skill-chip-community").click();
  await expect(page.getByTestId("skill-chip-community")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("skill-entry")).toHaveCount(1);
  await expect(entry(page, "sql-formatter")).toBeVisible();
  await page.getByTestId("skill-chip-plugin").click();
  await expect(page.getByTestId("skill-results-none")).toHaveText("Nothing matches “sql”.");
  await page.getByTestId("skill-chip-community").click();
  await expect(page.getByTestId("skill-entry")).toHaveCount(1);
  const plugin = entry(page, "enterprise-data", "plugin");
  await expect(plugin.getByTestId("skill-browse-update")).toHaveText("Update to 1.4.0");
  await plugin.getByTestId("skill-plugin-skills").click();
  await expect(plugin.getByTestId("skill-plugin-skill-list").locator("li")).toHaveCount(4);
  // Both kinds on is any kind.
  await page.getByTestId("skill-chip-skill").click();
  await expect(page.getByTestId("skill-results")).toHaveText("4 results");

  // A chip pressed while typing still waits takes the text along; the wait does not undo it.
  await page.getByTestId("skill-chip-plugin").click();
  await page.getByTestId("skill-chip-skill").click();
  await expect(page.getByTestId("skill-results")).toHaveText("4 results");
  await search(page).fill("data");
  await page.getByTestId("skill-chip-community").click();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("skill-results")).toHaveText("1 result");
  await expect(entry(page, "pandas-tips")).toBeVisible();
});

test("Install from Browse runs skill.install and the hit turns Installed", async ({ page }) => {
  await openSkills(page);
  await search(page).fill("dbt");
  const dbt = entry(page, "dbt-model");
  await expect(dbt.getByTestId("skill-install")).toBeVisible();
  await dbt.getByTestId("skill-install").click();
  await expect(dbt.getByTestId("skill-installed-mark")).toHaveText("Installed");
  await expect(installed(page, "dbt-model").getByTestId("skill-state")).toHaveText("Enabled");
  expect((await invocations()).filter((c) => c.name === "skill.install").map((c) => c.args)).toEqual([{ name: "dbt-model", kind: "skill" }]);

  // A failure stays under its row until dismissed.
  await mockPost(`skills?fail=skill.install&error=${encodeURIComponent("~/.claude/skills/k8s-manifest exists and is not ours")}`);
  await search(page).fill("k8s");
  await entry(page, "k8s-manifest").getByTestId("skill-install").click();
  await expect(entry(page, "k8s-manifest").getByTestId("skill-failure")).toContainText("~/.claude/skills/k8s-manifest exists and is not ours");
  await entry(page, "k8s-manifest").getByTestId("skill-failure-dismiss").click();
  await expect(entry(page, "k8s-manifest").getByTestId("skill-failure")).toHaveCount(0);
});

test("Disable asks once, with the restart warning; Cancel runs nothing", async ({ page }) => {
  await openSkills(page);
  const pr = installed(page, "pr-review");
  await pr.getByTestId("skill-disable").click();
  const dialog = page.getByTestId("skill-confirm");
  await expect(dialog).toContainText("Disable pr-review?");
  await expect(dialog).toContainText(RESTART);
  await page.getByTestId("skill-confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name === "skill.disable")).toHaveLength(0);

  await pr.getByTestId("skill-disable").click();
  await page.getByTestId("skill-confirm-ok").click();
  await expect(pr.getByTestId("skill-state")).toHaveText("Disabled");
  // The daemon's confirm was answered by the page: no second dialog.
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  // Remove on the local skill says it deletes a skill you wrote.
  await installed(page, "my-notes").getByTestId("skill-remove").click();
  await expect(dialog).toContainText("a skill you wrote");
  await expect(dialog).toContainText(RESTART);
  await page.getByTestId("skill-confirm-ok").click();
  await expect(installed(page, "my-notes")).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});

test("Run setup is off with no thread or project selected, and its tooltip says why", async ({ page }) => {
  await openSkills(page);
  const setup = installed(page, "jira-sync").getByTestId("skill-setup");
  await expect(setup).toBeDisabled();
  await expectTooltip(page, installed(page, "jira-sync").getByTestId("skill-setup-wrap"), "Select a thread or project first: setup runs in its bottom panel.");
});

test("Run setup with a thread selected runs skill.setup and reveals its bottom panel", async ({ page }) => {
  await openSkills(page, "s:s-3");
  const setup = installed(page, "jira-sync").getByTestId("skill-setup");
  await expect(setup).toBeEnabled();
  await setup.click();
  // The panel is the thread's: Settings closes for it.
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect.poll(async () => (await invocations()).some((c) => c.name === "skill.setup" && c.args.name === "jira-sync")).toBe(true);
});

test("Registries lists the marketplace, and says how to add one when Claude Code has none", async ({ page }) => {
  await openSkills(page);
  const reg = page.locator('[data-testid="skill-registry"][data-name="ai-marketplace"]');
  await expect(reg).toContainText("cof-primary/ai-marketplace");
  await expect(reg.getByTestId("skill-registry-line")).toContainText("3 plugins · 39 skills · read ");

  await mockPost("skills?registries=none");
  await expect(page.getByTestId("skill-registries-none")).toHaveText(
    "No marketplace is configured. Add your organisation's with claude plugin marketplace add <owner/repo> (for example ai-marketplace) and Refresh.",
  );
  await expect(page.getByTestId("skill-registry")).toHaveCount(0);
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
