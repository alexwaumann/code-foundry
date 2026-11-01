import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

// Snoozed threads in the GUI (docs/notes/snooze-threads-2-sidebar.md). The default world
// has two snoozed threads: s-8 ("Refactor the gh poller", a finished turn, wakes in 2.5 h)
// and s-9 ("Bump wails to v3.1", wakes in 4 days and 1 h). The Snoozed section is
// collapsed by default.

test.beforeEach(async () => {
  await resetMock();
});

const list = (page: Page) => page.getByTestId("thread-list");

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  });
}

// The Snoozed header (collapsed by default, its label, count and name), the order once expanded, the
// one-line rows with the time left and no actions, the section going once none is snoozed:
// src/components/sidebar/Sidebar.test.tsx ("the Snoozed and Archived footers"); not counted while
// snoozed: src/stores/threads.test.ts (attentionIds); the card not repeating the wake time: src/components/sidebar/SidebarRow.test.tsx.
test("Snoozed section: stacked between Working and Archived; quiet rows at the live rows' size; expanded survives a reload", async ({ page }) => {
  await openApp(page);
  expect((await box(page, "sidebar-snoozed")).top).toBeGreaterThanOrEqual((await box(page, "sidebar-working")).bottom - 0.5);
  expect((await box(page, "sidebar-archived")).top).toBeGreaterThanOrEqual((await box(page, "sidebar-snoozed")).bottom - 0.5);
  await page.getByTestId("snoozed-header").click();
  const s8 = row(page, "s:s-8");
  await expect(s8.getByTestId("thread-body")).toHaveCSS("opacity", "1");
  await expect(s8.getByTestId("thread-name")).toHaveCSS("font-weight", "400");
  await expect(s8.getByTestId("thread-name")).toHaveCSS("font-size", await row(page, "s:s-2").getByTestId("thread-name").evaluate((el) => getComputedStyle(el).fontSize));
  await page.reload();
  await expect(page.getByTestId("snoozed-header")).toHaveAttribute("aria-expanded", "true");
});

// The Snooze submenu's presets and times, a preset's thread.snooze, Unsnooze, and the Snoozed section's order
// and countdown: unit-tested in src/components/thread/ThreadMenuItems.test.tsx, src/lib/snooze.test.ts,
// src/stores/threadActions.test.ts, src/lib/tree.test.ts and src/components/sidebar/SidebarRow.test.tsx (the
// daemon asks only mid-turn: internal/command/commands_thread_snooze_test.go).

// Snoozing a working thread from the title menu: the presets and their times
// (src/components/thread/ThreadMenuItems.test.tsx, src/lib/snooze.test.ts), the daemon asking only
// mid-turn (internal/command/commands_thread_snooze_test.go) and the retry confirmed
// (src/stores/commands.test.ts, src/components/confirm/ConfirmDialog.test.tsx), its panels dropped and
// the window landing home, whoever snoozed it (src/stores/archiveCleanup.test.ts), the composer's
// "Snoozed until …" and Unsnooze (src/components/thread/SnoozeNote.test.tsx), the title menu's Unsnooze
// (ThreadMenuItems.test.tsx), back in the main list's waiting band (src/components/sidebar/Sidebar.test.tsx).

// Pick a date and time: the dialog for the row's thread and the local time it sends, unit-tested in
// src/components/snooze/SnoozeDialog.test.tsx and src/components/thread/ThreadMenuItems.test.tsx.

// A wake: back on top of the main list, Woke in amber, snooze ended (src/components/sidebar/Sidebar.test.tsx),
// counted in the title (src/stores/threads.test.ts), the composer's "Snooze ended · just now"
// (src/components/thread/SnoozeNote.test.tsx); snoozing again from the title menu
// (ThreadMenuItems.test.tsx); a message unsnoozing is the daemon's (internal/store/thread snooze_test.go).

test("the keyboard walks main → Working → Snoozed → Archived; collapsed sections are skipped", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await page.getByTestId("archived-header").click();
  await list(page).focus();
  await page.keyboard.press("Home");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-2");
  for (const want of ["s-6", "s-4", "s-3", "s-5", "s-1", "s-8", "s-9", "s-7"]) {
    await page.keyboard.press("ArrowDown");
    await expect(list(page)).toHaveAttribute("aria-activedescendant", `row-s:${want}`);
  }
  // The last row: ArrowDown stays.
  await page.keyboard.press("ArrowDown");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-7");
  await expect(row(page, "s:s-7")).toHaveAttribute("data-cursor", "true");
  // cmd+N counts the snoozed rows: s-2, s-6, s-4, s-3, s-5, s-1, s-8, s-9, s-7.
  await page.keyboard.press("Meta+7");
  await expect(row(page, "s:s-8")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+9");
  await expect(row(page, "s:s-7")).toHaveAttribute("aria-selected", "true");

  // Snoozed collapsed: from s-7, ArrowUp lands on s-1; cmd+7 is s-7.
  await page.getByTestId("snoozed-header").click();
  await list(page).focus();
  await page.keyboard.press("End");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-7");
  await page.keyboard.press("ArrowUp");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-1");
  await page.keyboard.press("Meta+7");
  await expect(row(page, "s:s-7")).toHaveAttribute("aria-selected", "true");
  // Past the last row cmd+N does nothing.
  await page.keyboard.press("Meta+8");
  await expect(row(page, "s:s-7")).toHaveAttribute("aria-selected", "true");
  // cmd+shift+a never lands on a snoozed thread (s-8 waits, but is snoozed).
  await page.getByTestId("snoozed-header").click();
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
});

// The palette's Snooze opening the custom dialog for the selected thread: src/stores/snoozeDialog.test.ts;
// the dialog snoozing it: src/components/snooze/SnoozeDialog.test.tsx.

test("the hover snooze menu keeps the row's card shut, and clicking away leaves it shut", async ({ page }) => {
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  const r = row(page, "s:s-3");
  await r.hover();
  await expect(tip).toBeVisible();
  await r.getByTestId("row-snooze").click();
  const menu = page.getByTestId("row-snooze-menu");
  await expect(menu).toBeVisible();
  await expect(tip).toHaveCount(0);
  // Along the presets: the card stays shut the whole way.
  for (const preset of await menu.getByTestId("snooze-preset").all()) {
    await preset.hover();
    await page.waitForTimeout(100);
    await expect(tip).toHaveCount(0);
  }
  // Away from the menu and the row, then a click there closes the menu: still shut.
  const main = await page.getByTestId("content-pane").boundingBox();
  if (!main) throw new Error("no content pane");
  await page.mouse.move(main.x + main.width / 2, main.y + main.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(menu).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(tip).toHaveCount(0);
  // Back over the row: it opens as usual.
  await r.hover();
  await expect(tip).toBeVisible();
});
