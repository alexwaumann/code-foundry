import { expect, test } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The snooze holds (docs/notes/snooze-holds-archive-refuses.md). Which section a snoozed thread
 * is in and what its row shows are vitest's (lib/shellSections, SidebarRow); this only saves the
 * PR's screenshots with SHOTS=<dir>: the sidebar with a snoozed thread that works (its working
 * status before the countdown) and one that asks (under Needs you, not Snoozed).
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

for (const scheme of ["dark", "light"] as const) {
  test(`snooze holds screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await mockPost("snooze-holds");
    await openApp(page);
    await page.getByTestId("snoozed-header").click();
    await expect(row(page, "s:s-8")).toBeVisible();
    await page.mouse.move(1390, 890);
    await page.screenshot({ path: `${shots ?? ""}/snooze-holds-sidebar-${scheme}.png`, clip: { x: 0, y: 0, width: 256, height: 900 }, scale: "device" });
  });
}
