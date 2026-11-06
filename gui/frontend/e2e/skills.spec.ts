import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock } from "./fixtures";

/**
 * Settings → Skills (docs/notes/skills-page-redesign.md) against the mock's ai-marketplace
 * (mock/skills.ts). Only what needs a browser: the rows, groups, search, chips, switches,
 * menus and Update all are unit-tested in src/components/skill/settings/SkillsPage.test.tsx,
 * the search's ranking and filters in internal/store/skill/marketplace/search_test.go.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function openSkills(page: Page) {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-skills").click();
  await expect(page.getByTestId("skill-installed-row").first()).toBeVisible();
}

test("Browse all is virtualised on the page's scroll box, and a row opened in it is measured in place", async ({ page }) => {
  await openSkills(page);
  await page.getByTestId("skill-browse-all").click();
  const rows = page.getByTestId("skill-catalog-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  const total = await page.getByTestId("catalog-group-count").textContent();
  expect(Number(total)).toBeGreaterThan(40);
  await expect.poll(() => page.getByTestId("skill-entry").count()).toBeLessThan(Number(total));

  const first = page.getByTestId("skill-entry").first();
  const next = page.getByTestId("skill-entry").nth(1);
  const before = (await next.boundingBox())?.y ?? 0;
  await first.getByTestId("catalog-chevron").click();
  await expect(first.getByTestId("catalog-details")).toBeVisible();
  await expect.poll(async () => (await next.boundingBox())?.y ?? 0).toBeGreaterThan(before + 20);

  // The last rows come in as the page scrolls.
  await page.getByTestId("settings-body").evaluate((el) => {
    const box = el.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  });
  await expect(page.locator('[data-testid="skill-entry"][data-name="vendor-risk"]')).toBeVisible();
});

test("Escape closes the Registries dialog and leaves Settings open; right-click opens a row's menu at the pointer", async ({ page }) => {
  await openSkills(page);
  await page.getByTestId("skill-menu").click();
  await page.getByTestId("skill-registries-open").click();
  await expect(page.getByTestId("skill-registries")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("skill-registries")).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toBeVisible();

  const row = page.locator('[data-testid="skill-installed-row"][data-name="pr-review"]');
  const box = await row.boundingBox();
  await row.click({ button: "right", position: { x: 200, y: 12 } });
  const menu = page.getByTestId("skill-row-menu-context");
  await expect(menu).toBeVisible();
  const at = await menu.boundingBox();
  expect(Math.abs((at?.x ?? 0) - ((box?.x ?? 0) + 200))).toBeLessThan(8);
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1280x800, dark and light: default, search, Browse all, Update all. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("default, search, Browse all, Update all", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await openSkills(page);
      const shot = (name: string) => page.screenshot({ path: `${shots ?? ""}/skills-${name}-${scheme}.png` });
      await shot("default");
      await page.getByTestId("skill-search").fill("sql");
      await expect(page.getByTestId("skill-entry").first()).toBeVisible();
      await page.getByTestId("skill-entry").first().getByTestId("catalog-chevron").click();
      await shot("search");
      await page.getByTestId("skill-search").fill("");
      await page.getByTestId("skill-browse-all").click();
      await expect(page.getByTestId("skill-catalog-rows")).toHaveAttribute("data-virtual", "true");
      await shot("browse");
      await page.getByTestId("skill-browse-all").click();
      await mockPost(`skills?fail=skill.update&error=${encodeURIComponent("claude plugin update failed: could not reach the marketplace.")}`);
      await page.getByTestId("skill-update-all").click();
      await expect(page.getByTestId("skill-update-all")).toContainText("Updating 2 of 3");
      await shot("update-all");
    });
  });
}
