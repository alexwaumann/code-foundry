import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

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
    return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right };
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
  await expect(s8.getByTestId("thread-body")).toHaveCSS("opacity", "0.6");
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
// the window landing home, whoever snoozed it (src/stores/archiveCleanup.test.ts), the pill's snooze
// segment, "Snoozed until …" and Dismiss snooze (src/components/thread/ComposerRow.test.tsx), the title menu's Unsnooze
// (ThreadMenuItems.test.tsx), back in the main list's waiting band (src/components/sidebar/Sidebar.test.tsx).

// Pick a date and time: the dialog for the row's thread and the local time it sends, unit-tested in
// src/components/snooze/SnoozeDialog.test.tsx and src/components/thread/ThreadMenuItems.test.tsx.

// A wake: back on top of the main list, Woke in amber, snooze ended (src/components/sidebar/Sidebar.test.tsx,
// src/components/sidebar/shell/ShellSidebarList.test.tsx), counted in the title (src/stores/threads.test.ts),
// the row's Snooze and Clear (src/components/sidebar/SidebarRow.test.tsx), the pill's snooze segment with Clear
// and the snooze menu (src/components/thread/ComposerRow.test.tsx); snoozing again from the title menu
// (ThreadMenuItems.test.tsx); a message unsnoozing and Clear are the daemon's (internal/store/thread snooze_test.go).

// Which actions a woken row has and what they run: SidebarRow.test.tsx. This is where they sit: in the
// hover slot of line 1, over the status, Clear's right edge where Archive's is on any other row.
test("a woken row's Snooze and Clear sit where Snooze and Archive sit, over its Woke", async ({ page }) => {
  await mockPost("thread/snooze?id=s-3&until=2m");
  await mockPost("thread/wake?id=s-3");
  await openApp(page);
  const woken = row(page, "s:s-3");
  await expect(woken.getByTestId("row-status")).toHaveText("Woke");
  const right = (r: ReturnType<typeof row>, id: string) => r.getByTestId(id).evaluate((el) => Math.round(el.getBoundingClientRect().right));
  const lineTop = (r: ReturnType<typeof row>, id: string) =>
    r.getByTestId(id).evaluate((el) => Math.round(el.getBoundingClientRect().top - (el.closest('[data-testid="row-line-1"]')?.getBoundingClientRect().top ?? NaN)));
  await woken.hover();
  await expect(woken.getByTestId("row-clear")).toBeVisible();
  await expect(woken.getByTestId("row-status")).toBeHidden();
  const clear = { right: await right(woken, "row-clear"), top: await lineTop(woken, "row-clear") };
  const idle = row(page, "s:s-5");
  await idle.hover();
  await expect(idle.getByTestId("row-archive")).toBeVisible();
  expect(clear).toEqual({ right: await right(idle, "row-archive"), top: await lineTop(idle, "row-archive") });
});

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
  // cmd+shift+a (the next Needs-you popup) never lands on a snoozed thread (s-8 waits, but is snoozed).
  await page.getByTestId("snoozed-header").click();
  const popup = page.getByTestId("needs-popup");
  await page.keyboard.press("Meta+Shift+a");
  await expect(popup).toHaveAttribute("data-thread-id", "s-2");
  await page.keyboard.press("Meta+Shift+a");
  await expect(popup).toHaveAttribute("data-thread-id", "s-2");
});

// The row showing, the header's state and count, the arrows, children and a wake: src/components/sidebar/Sidebar.test.tsx
// and src/lib/tree.test.ts. This is what the real list and the keymap do with it.
test("the open thread keeps its one-line row under the collapsed header, and cmd+N counts it", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await row(page, "s:s-9").click();
  await page.getByTestId("snoozed-header").click();
  await expect(page.getByTestId("snoozed-header")).toHaveAttribute("aria-expanded", "false");
  const footer = await box(page, "sidebar-snoozed");
  const r = await row(page, "s:s-9").evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  // Header, then the one row and the panel's 4px below it.
  expect(footer.height).toBe(26 + 24 + 4);
  expect(r.bottom).toBeLessThanOrEqual(footer.bottom);
  // s-2, s-6, s-4, s-3, s-5, s-1, the open s-9, then s-7: the row counts, so cmd+8 is s-7.
  await page.getByTestId("archived-header").click();
  await page.keyboard.press("Meta+8");
  await expect(row(page, "s:s-7")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "s:s-9")).toHaveCount(0);
});

// What the snooze segment says and does: src/components/thread/ComposerRow.test.tsx. This is the dock's geometry.
test("a saved thread waiting on things shows both in the one pill above the composer; dismissed, the dock keeps its height", async ({ page }) => {
  await mockPost("thread?state=waiting");
  await mockPost("thread/snooze?id=s-r1&save=true");
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await row(page, "s:s-r1").click();
  await page.getByTestId("snoozed-header").click();
  await expect(page.getByTestId("pill-snooze")).toBeVisible();
  await expect(page.getByTestId("pill-waiting")).toBeVisible();
  const snooze = await box(page, "pill-snooze");
  const waiting = await box(page, "pill-waiting");
  const composer = await box(page, "thread-composer");
  expect(snooze.top).toBe(waiting.top);
  expect(snooze.right).toBeLessThanOrEqual(waiting.left + 1);
  expect(snooze.bottom).toBeLessThan(composer.top);
  // The dock's height is the list's bottom inset: the row is always in it, so nothing moves when the snooze goes.
  const dock = () => page.locator(".dock").evaluate((el) => el.getBoundingClientRect().height);
  const both = await dock();
  await page.getByTestId("pill-snooze").click();
  await page.getByTestId("snooze-dismiss").click();
  await expect(page.getByTestId("pill-snooze")).toHaveCount(0);
  await expect(row(page, "s:s-r1")).toHaveAttribute("data-section", /^(?!snoozed).*/);
  expect(await dock()).toBe(both);
  expect((await box(page, "thread-composer")).top).toBe(composer.top);
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
  // Away from the menu and the row, then a click on the pane area closes the menu: still shut.
  const main = await page.getByTestId("shell-grid").boundingBox();
  if (!main) throw new Error("no pane area");
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

// The row text, sort, menu contents and which command runs: unit tests (SidebarRow, tree,
// ThreadMenuItems). This is the flow across the daemon's stream: the row leaves the main list
// for the Snoozed section, after the timed ones.
test("Save for later: the row menu moves the thread under Snoozed, after the timed ones", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await row(page, "s:s-3").click({ button: "right" });
  await page.getByTestId("menu-snooze").hover();
  await page.getByTestId("snooze-save").click();
  const saved = row(page, "s:s-3");
  await expect(saved).toHaveAttribute("data-section", "snoozed");
  await expect(saved.getByTestId("row-saved")).toHaveText("Saved");
  await expect(page.getByTestId("snoozed-count")).toHaveText("3");
  await expect(list(page).locator('[data-section="snoozed"][data-row-kind="thread"]').last()).toHaveAttribute("data-row-key", "s:s-3");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1280x800 at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`save for later screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
    test("the menu, the saved row and the saved thread's page", async ({ page }, info) => {
      const dir = process.env.SHOTS;
      test.skip(!dir || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await mockPost("thread/snooze?id=s-9&save=true");
      await openApp(page);
      await page.getByTestId("snoozed-header").click();
      await row(page, "s:s-2").click({ button: "right" });
      await page.getByTestId("menu-snooze").hover();
      await expect(page.getByTestId("snooze-save")).toBeVisible();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(dir)}/menu-${scheme}.png` });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await row(page, "s:s-9").click();
      await expect(page.getByTestId("snooze-sentence")).toHaveText("Saved for later");
      await page.mouse.move(640, 300);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(dir)}/saved-${scheme}.png` });
    });
  });
}

/** SHOTS=<dir>: the PR's screenshots of a woken thread, WebKit, 1280x800 at 2x, dark and light: the row at rest, hovered, and the thread's dock. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`woken thread screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
    test("the woken row at rest and hovered, and the woken thread", async ({ page }, info) => {
      const dir = process.env.SHOTS;
      test.skip(!dir || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await mockPost("thread/snooze?id=s-3&until=2m");
      await mockPost("thread/wake?id=s-3");
      await openApp(page);
      const woken = row(page, "s:s-3");
      await expect(woken).toHaveAttribute("data-section", /.+/);
      await page.mouse.move(640, 300);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(dir)}/woken-row-${scheme}.png`, clip: { x: 0, y: 0, width: 520, height: 420 } });
      await woken.getByTestId("thread-name").hover();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${String(dir)}/woken-row-hover-${scheme}.png`, clip: { x: 0, y: 0, width: 520, height: 420 } });
      await woken.getByTestId("thread-name").click();
      await expect(page.getByTestId("thread-composer")).toBeVisible();
      await page.mouse.move(640, 300);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${String(dir)}/woken-thread-${scheme}.png` });
    });
  });
}
