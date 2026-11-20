import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock } from "./fixtures";

/**
 * Auto-tidy (docs/notes/auto-tidy.md): screenshots only. Its rules are Go table tests
 * (internal/store/thread/autotidy_test.go, internal/daemon/auto_tidy_test.go); the row's "Auto",
 * the card's sentence and the settings rows are vitest (SidebarRow.test.tsx,
 * SettingsPage.test.tsx). SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

test.beforeEach(async () => {
  await resetMock();
});

const SCHEMES = ["dark", "light"] as const;

/** The settings page's General › Snooze section, cut to it. */
async function shootSettings(page: Page, shots: string, name: string) {
  await page.keyboard.press("Meta+Comma");
  const section = page.locator('[data-section="snooze"]');
  await expect(section.locator("[data-setting]").first()).toBeVisible();
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await section.screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.keyboard.press("Escape");
}

test("SHOTS: the settings rows", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openApp(page);
  await mockPost("settings/external?threads.auto_save_after=3d");
  await shootSettings(page, shots, "settings");
});

test("SHOTS: a pass saves idle threads (Snoozed, Auto) and tells the bell", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  // Three more at rest at their prompt, and one the user saved, for the two words side by side.
  for (const id of ["s-1", "s-2", "s-6"]) await mockPost(`thread/status?id=${id}&status=idle&reason=at%20prompt`);
  await mockPost("thread/snooze?id=s-3&save=true");
  await page.getByTestId("snoozed-header").click();
  await expect(page.getByTestId("snoozed-header")).toHaveAttribute("aria-expanded", "true");
  const sidebar = page.getByTestId("sidebar");
  await page.mouse.move(900, 700);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await sidebar.screenshot({ path: `${shots}/sidebar-before-${scheme}.png` });
  }

  await mockPost("settings/external?threads.auto_save_after=3d");
  const pass = (await mockPost("auto-tidy?days=4")) as { saved: string[] };
  expect(pass.saved.length).toBeGreaterThan(0);
  const auto = page.locator('[data-section="snoozed"] [data-testid="row-saved"][data-auto]').first();
  await expect(auto).toBeVisible();
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(900, 700);
    await page.waitForTimeout(200);
    await sidebar.screenshot({ path: `${shots}/sidebar-after-${scheme}.png` });
    // The hover card's full sentence.
    await auto.hover();
    await expect(page.getByTestId("tip-auto-saved")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/card-${scheme}.png`, clip: { x: 0, y: 0, width: 760, height: 800 } });
  }

  await page.mouse.move(900, 700);
  await page.getByTestId("notification-bell").click();
  const pop = page.getByTestId("notification-popover");
  await expect(pop).toContainText(/\d idle threads were saved for later/);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await pop.screenshot({ path: `${shots}/bell-${scheme}.png` });
  }
});
