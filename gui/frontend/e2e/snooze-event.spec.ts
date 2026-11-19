import { expect, test, type Page } from "@playwright/test";
import { invokeAs, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Snoozing a thread until an event (docs/notes/snooze-until-event.md), what only the browser
 * shows: the row's menu reaching Until event's submenu, then More events taking the keyboard, a
 * typed filter and Enter snoozing until the event, the row moving to Snoozed with its label.
 * The submenu's contents, the fill rule, the filter, the settings section and the row's words
 * are vitest's (src/lib/snoozeEvents.test.ts, src/components/snooze/UntilEventMenu.test.tsx,
 * src/components/settings/SnoozeEventsSettings.test.tsx, src/components/sidebar/SidebarRow.test.tsx).
 * The thread: the thread info card's ws9 fixture (s-ti-ws), with open pull requests #1088,
 * #412, #58 and #57 (checks done on #57 and #412). SHOTS=<dir> for the PR's screenshots.
 */

const THREAD = "s-ti-ws";

test.beforeEach(async () => {
  await resetMock();
});

async function setup(page: Page): Promise<void> {
  await openApp(page);
  await mockPost("thread-info?scenario=ws9");
  await expect(row(page, `s:${THREAD}`)).toBeVisible();
}

/** The row's menu, Snooze, then Until event's submenu. */
async function openUntilEvent(page: Page): Promise<void> {
  await row(page, `s:${THREAD}`).click({ button: "right" });
  await page.getByTestId("menu-snooze").hover();
  await page.getByTestId("snooze-until-event").hover();
  await expect(page.getByTestId("snooze-events")).toBeVisible();
}

test("More events: the filter has the keyboard, typing narrows, Enter snoozes until the event", async ({ page }) => {
  await setup(page);
  await openUntilEvent(page);
  await page.getByTestId("snooze-more-events").click();
  const filter = page.getByTestId("snooze-event-filter");
  await expect(filter).toBeFocused();
  await page.keyboard.type("1088 merged");
  await expect(page.getByTestId("snooze-event-row")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("snooze-event-dialog")).toBeHidden();
  await page.getByTestId("snoozed-header").click();
  await expect(row(page, `s:${THREAD}`)).toHaveAttribute("data-section", "snoozed");
  await expect(row(page, `s:${THREAD}`).getByTestId("row-snooze-event")).toHaveText("#1088 merged");
});

/** Sets the Until event setting through the settings store, as the section's checkboxes do. */
async function setEvents(page: Page, value: string): Promise<void> {
  await page.evaluate(
    (v) =>
      (window as unknown as { __cfModule: (p: string) => Promise<{ saveSettings: (x: Record<string, string>) => Promise<unknown> }> })
        .__cfModule("/src/stores/settings.ts")
        .then((m) => m.saveSettings({ "threads.snooze_events": v })),
    value,
  );
}

test("SHOTS: the Until event submenu, More events, the settings section, the Snoozed row and its card, a woken row", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await setup(page);
  await setEvents(page, "checks_done review merged plugin:hello/tick plugin:doc-preview/deploy");
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openUntilEvent(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/until-event-menu-${scheme}.png` });
    await page.getByTestId("snooze-more-events").click();
    await expect(page.getByTestId("snooze-event-filter")).toBeFocused();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/more-events-${scheme}.png` });
    await page.keyboard.type("deploy");
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${shots}/more-events-filtered-${scheme}.png` });
    await page.keyboard.press("Escape");
    await openUntilEvent(page);
    await page.getByTestId("snooze-choose-events").click();
    await expect(page.getByTestId("snooze-events-setting")).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/settings-section-${scheme}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("snooze-events-setting")).toBeHidden();
  }
  // Snooze until #1088's checks, then until a plugin event on another thread, and show the rows.
  await openUntilEvent(page);
  await page.locator('[data-testid="snooze-event"][data-event="acme/web#1088 checks_done"]').click();
  expect((await invokeAs("s-3", "thread.snooze", { "until-plugin": "doc-preview/deploy" })).ok).toBe(true);
  const header = page.getByTestId("snoozed-header");
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(row(page, `s:${THREAD}`).getByTestId("row-snooze-event")).toHaveText("#1088 checks");
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(900, 700);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/snoozed-rows-${scheme}.png`, clip: { x: 0, y: 0, width: 640, height: 800 } });
    await row(page, `s:${THREAD}`).hover();
    await expect(page.getByTestId("tip-snooze-event")).toHaveText("Snoozed until checks finish on #1088");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/snoozed-card-${scheme}.png`, clip: { x: 0, y: 0, width: 760, height: 800 } });
  }
  // The checks finish: the snooze ends, saying how.
  await mockPost(`thread/snooze-event-fire?id=${THREAD}&by=${encodeURIComponent("Checks failed on #1088 (2 of 14)")}`);
  await expect(row(page, `s:${THREAD}`)).not.toHaveAttribute("data-section", "snoozed");
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(900, 700);
    await row(page, `s:${THREAD}`).hover();
    await expect(page.getByTestId("tip-snooze-event")).toHaveText("Checks failed on #1088 (2 of 14)");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/woken-card-${scheme}.png`, clip: { x: 0, y: 0, width: 760, height: 800 } });
  }
});
