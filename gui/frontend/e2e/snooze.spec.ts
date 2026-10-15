import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

// Snoozed threads in the GUI (docs/notes/snooze-threads-2-sidebar.md). The default world
// has two snoozed threads: s-8 ("Refactor the gh poller", a finished turn, wakes in 2.5 h)
// and s-9 ("Bump wails to v3.1", wakes in 4 days and 1 h). The Snoozed section is
// collapsed by default.

test.beforeEach(async () => {
  await resetMock();
});

const list = (page: Page) => page.getByTestId("thread-list");

/** Row keys in display order, headers as "# Label". */
function rowKeys(page: Page): Promise<string[]> {
  return list(page)
    .locator("[data-row-key]")
    .evaluateAll((els) => els.map((e) => (e.getAttribute("data-row-kind") === "header" ? `# ${e.textContent}` : (e.getAttribute("data-row-key") ?? ""))));
}

function mainKeys(page: Page): Promise<string[]> {
  return page
    .getByTestId("sidebar-main")
    .locator("[data-row-key]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key") ?? ""));
}

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  });
}

async function openMenu(page: Page, key: string) {
  await row(page, key).click({ button: "right" });
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** The row menu's Snooze submenu, open. */
async function openSnoozeSub(page: Page, key: string) {
  const menu = await openMenu(page, key);
  await menu.getByTestId("menu-snooze").click();
  const sub = page.getByTestId("menu-snooze-presets");
  await expect(sub).toBeVisible();
  return { menu, sub };
}

const lastSnooze = async () => (await invocations()).filter((i) => i.name === "session.snooze").at(-1);

test("Snoozed section: collapsed by default between Working and Archived; expanded, single-line rows with the time left, soonest first", async ({ page }) => {
  await openApp(page);
  const header = page.getByTestId("snoozed-header");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("snoozed-label")).toHaveText("Snoozed");
  await expect(page.getByTestId("snoozed-count")).toHaveText("2");
  await expect(header).toHaveAccessibleName("Snoozed 2");
  await expect(row(page, "s:s-8")).toHaveCount(0);
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "# Archived 1"]);
  expect((await box(page, "sidebar-snoozed")).top).toBeGreaterThanOrEqual((await box(page, "sidebar-working")).bottom - 0.5);
  expect((await box(page, "sidebar-archived")).top).toBeGreaterThanOrEqual((await box(page, "sidebar-snoozed")).bottom - 0.5);
  // s-8's finished turn does not count while snoozed: the bell shows s-2 alone.
  await expect(page.getByTestId("sidebar-notifications").getByTestId("attention-badge")).toHaveText("1");

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "s:s-8", "s:s-9", "# Archived 1"]);
  const s8 = row(page, "s:s-8");
  await expect(s8).toHaveAttribute("data-section", "snoozed");
  await expect(s8.getByTestId("session-name")).toHaveText("Refactor the gh poller");
  await expect(s8.getByTestId("row-snooze-left")).toHaveText("2h");
  await expect(row(page, "s:s-9").getByTestId("row-snooze-left")).toHaveText("4d");
  // One line, same height as an archived row (a thread row is 15px taller); not dimmed.
  await expect(s8.getByTestId("row-place")).toHaveCount(0);
  const one = (await s8.boundingBox())?.height ?? 0;
  const two = (await row(page, "s:s-3").boundingBox())?.height ?? 0;
  expect(two - one).toBe(15);
  await expect(s8.getByTestId("session-body")).not.toHaveAttribute("data-offline", /.*/);
  // Same left edge as the main list's rows.
  expect((await s8.boundingBox())?.x).toBe((await row(page, "s:s-3").boundingBox())?.x);

  // The tooltip adds the full wake time.
  await s8.hover();
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId("tip-snooze")).toHaveText(/^Snoozed until (Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M$/);
  await expect(tip.getByTestId("tip-status")).toHaveCount(0);
  await page.mouse.move(900, 400);

  // Expanded survives a reload.
  await page.reload();
  await expect(page.getByTestId("snoozed-header")).toHaveAttribute("aria-expanded", "true");
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("code-foundry.ui") ?? "{}") as { state?: { snoozedCollapsed?: boolean } }).state?.snoozedCollapsed)).toBe(false);

  // Both unsnoozed (as from the CLI): no section.
  await mockPost("session/snooze?id=s-8&clear=true");
  await mockPost("session/snooze?id=s-9&clear=true");
  await expect(page.getByTestId("sidebar-snoozed")).toHaveCount(0);
  await expect(row(page, "s:s-8")).toHaveAttribute("data-section", "done");
  // Unsnoozing early is not a wake: s-8 is its finished turn again, and counts.
  await expect(page.getByTestId("sidebar-notifications").getByTestId("attention-badge")).toHaveText("2");
});

test("the row menu's Snooze submenu: presets with their times; 1 hour snoozes without asking; Unsnooze brings it back", async ({ page }) => {
  await openApp(page);
  const { menu, sub } = await openSnoozeSub(page, "s:s-3");
  // After Pin, before Archive.
  const items = await menu.locator("[role=menuitem]").evaluateAll((els) => els.map((e) => e.textContent.trim()));
  expect(items.slice(0, 4)).toEqual(["Rename", "Pin", "Snooze", "Archive"]);
  await expect(menu.getByTestId("menu-unsnooze")).toHaveCount(0);
  const presets = sub.getByTestId("snooze-preset");
  await expect(presets).toHaveCount(4);
  expect(await presets.evaluateAll((els) => els.map((e) => e.getAttribute("data-preset")))).toEqual(["1h", "3h", "tomorrow", "next-week"]);
  await expect(presets.nth(0)).toContainText("1 hour");
  await expect(presets.nth(0).getByTestId("snooze-preset-time")).toHaveText(/^((Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?\d{1,2}:\d\d [AP]M$/);
  await expect(presets.nth(2)).toContainText("Tomorrow");
  await expect(presets.nth(2).getByTestId("snooze-preset-time")).toHaveText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 9:00 AM$/);
  await expect(presets.nth(3)).toContainText("Next week");
  await expect(presets.nth(3).getByTestId("snooze-preset-time")).toHaveText(/^(Mon 9:00 AM|[A-Z][a-z]{2} \d{1,2}, 9:00 AM)$/);
  await expect(sub.getByTestId("snooze-pick")).toHaveText("Pick a date and time…");

  const before = Date.now();
  await presets.nth(0).click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("3");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect.poll(() => mainKeys(page)).toEqual(["s:s-2", "s:s-6", "s:s-4"]);
  const inv = await lastSnooze();
  expect(inv?.context?.activeSessionId).toBe("s-3");
  const until = Date.parse(inv?.args.until ?? "");
  expect(until - before).toBeGreaterThan(3_600_000 - 10_000);
  expect(until - before).toBeLessThan(3_600_000 + 10_000);
  // Soonest first: s-3 (1 h) before s-8 (2.5 h).
  await page.getByTestId("snoozed-header").click();
  await expect.poll(() => rowKeys(page)).toContain("s:s-3");
  expect((await rowKeys(page)).slice(-5)).toEqual(["# Snoozed 3", "s:s-3", "s:s-8", "s:s-9", "# Archived 1"]);
  await expect(row(page, "s:s-3").getByTestId("row-snooze-left")).toHaveText(/^(59m|1h)$/);

  // A snoozed thread's menu also has Unsnooze.
  const again = await openMenu(page, "s:s-3");
  await expect(again.getByTestId("menu-snooze")).toBeVisible();
  await again.getByTestId("menu-unsnooze").click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("2");
  await expect(row(page, "s:s-3")).toHaveAttribute("data-section", "idle");
  expect((await lastSnooze())?.args).toEqual({ clear: "true" });
});

test("snoozing a working thread from the header asks first; it then drops its panels, and its page says until when", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", "s-1");
  await page.getByTestId("thread-header").getByTestId("bottom-toggle").click();
  await expect(page.getByTestId("bottom-panel")).toBeVisible();
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.openSurface("current", m.makeTab("files", "Files")))`);
  await expect(page.getByTestId("side-panel")).toBeVisible();

  const header = page.getByTestId("thread-header");
  await header.getByRole("button", { name: "Snooze Thread", exact: true }).click();
  const presets = page.getByTestId("pane-snooze-presets");
  await expect(presets).toBeVisible();
  await presets.locator('[data-preset="tomorrow"]').click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Claude is still working; snoozing ends the turn.");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("3");
  await expect(page.getByTestId("working-count")).toHaveText("1");
  const confirmed = (await invocations()).filter((i) => i.name === "session.snooze");
  expect(confirmed.map((i) => i.confirmed)).toEqual([false, true]);
  const until = new Date(confirmed[1]?.args.until ?? "");
  expect([until.getHours(), until.getMinutes()]).toEqual([9, 0]);

  // Still selected: disconnected, "Snoozed until <day> 9:00 AM" with Unsnooze next to Reconnect.
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", "s-1");
  const card = page.getByTestId("thread-disconnected");
  await expect(card).toContainText(/^Snoozed until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) 9:00 AM\. Reconnect to continue the conversation\./);
  await expect(card.getByTestId("thread-unsnooze")).toBeVisible();
  await expect(card.getByTestId("reconnect")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await expect(page.getByTestId("bottom-panel")).toHaveCount(0);
  expect(await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.usePanelStore.getState().byKey["session:s-1"])`)).toEqual({ open: false, tabs: [], activeTabId: null });
  // The header button unsnoozes now.
  await expect(header.getByRole("button", { name: "Unsnooze Thread" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Snooze Thread", exact: true })).toHaveCount(0);

  // The card's Unsnooze: back in the main list, still disconnected (interrupted), no attention added.
  await card.getByTestId("thread-unsnooze").click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("2");
  await expect(row(page, "s:s-1")).toHaveAttribute("data-section", "attention");
  await expect(card).toContainText("Not connected · closed. Reconnect to continue the conversation.");
  await expect(header.getByRole("button", { name: "Snooze Thread", exact: true })).toBeVisible();

  // Snoozed from the CLI (another client): the same panel reset.
  await row(page, "s:s-2").click();
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.openSurface("current", m.makeTab("files", "Files")))`);
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await mockPost("session/snooze?id=s-2&until=2h");
  await expect(page.getByTestId("snoozed-count")).toHaveText("3");
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
});

test("Pick a date and time…: a month calendar and a time; Snooze sends that local time; a past time is refused", async ({ page }) => {
  await openApp(page);
  const { sub } = await openSnoozeSub(page, "s:s-4");
  await sub.getByTestId("snooze-pick").click();
  const dialog = page.getByTestId("snooze-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Snooze “Investigate flaky e2e”");
  // Tomorrow is selected, today outlined, yesterday disabled; 9:00 AM.
  const iso = (d: Date) => `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  const day = (d: Date) => dialog.locator(`[data-day="${iso(d)}"]`);
  await expect(day(now)).toHaveAttribute("data-today", "true");
  await expect(day(tomorrow).first()).toHaveAttribute("aria-selected", "true");
  if (yesterday.getMonth() === now.getMonth()) await expect(day(yesterday)).toBeDisabled();
  await expect(dialog.getByTestId("snooze-time")).toHaveValue("09:00");
  await expect(dialog.getByTestId("snooze-prev-month")).toBeDisabled();

  // Today at 00:01 is past: Snooze is disabled.
  await day(now).click();
  await dialog.getByTestId("snooze-time").fill("00:01");
  await expect(dialog.getByTestId("snooze-submit")).toBeDisabled();
  await expect(dialog.getByTestId("snooze-summary")).toHaveText("In the past");

  // The 10th of next month at 2:30 PM.
  await dialog.getByTestId("snooze-next-month").click();
  const target = new Date(now.getFullYear(), now.getMonth() + 1, 10, 14, 30);
  await dialog.locator(`[data-day="${iso(target)}"]`).click();
  await dialog.getByTestId("snooze-time").fill("14:30");
  await expect(dialog.getByTestId("snooze-summary")).toHaveText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} 10(, \d{4})?$/);
  await dialog.getByTestId("snooze-submit").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("snoozed-count")).toHaveText("3");
  expect(Date.parse((await lastSnooze())?.args.until ?? "")).toBe(target.getTime());
  expect((await lastSnooze())?.context?.activeSessionId).toBe("s-4");

  // Cancel snoozes nothing.
  const again = await openSnoozeSub(page, "s:s-3");
  await again.sub.getByTestId("snooze-pick").click();
  await expect(page.getByTestId("snooze-dialog")).toBeVisible();
  await page.getByTestId("snooze-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("snooze-dialog")).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name === "session.snooze")).toHaveLength(1);
});

test("a wake brings the thread back needing attention: Snooze ended in amber, counted by the bell; snooze it again from the header", async ({ page }) => {
  await openApp(page);
  const bell = page.getByTestId("sidebar-notifications");
  await expect(bell.getByTestId("attention-badge")).toHaveText("1");
  await mockPost("session/wake?id=s-8");
  await expect(page.getByTestId("snoozed-count")).toHaveText("1");
  // Back in the main list, in the attention group (prompts: s-2, then s-8 by creation).
  await expect.poll(() => mainKeys(page)).toEqual(["s:s-2", "s:s-8", "s:s-6", "s:s-4", "s:s-3"]);
  const s8 = row(page, "s:s-8");
  await expect(s8).toHaveAttribute("data-section", "attention");
  await expect(s8.getByTestId("row-status")).toHaveText("Snooze ended · just now");
  await expect(s8.getByTestId("row-status")).toHaveClass(/text-warning/);
  await expect(bell.getByTestId("attention-badge")).toHaveText("2");
  await expectTooltip(page, bell, "2 threads need attention");

  // Its page: the disconnected card says so, in amber.
  await s8.click();
  const card = page.getByTestId("thread-disconnected");
  await expect(card).toContainText("Snooze ended · just now. Reconnect to continue the conversation.");
  await expect(card.getByTestId("thread-snooze-ended")).toHaveClass(/text-warning/);
  await expect(card.getByTestId("thread-unsnooze")).toHaveCount(0);

  // Snooze again from the header: 3 hours.
  await page.getByTestId("thread-header").getByRole("button", { name: "Snooze Thread", exact: true }).click();
  await page.getByTestId("pane-snooze-presets").locator('[data-preset="3h"]').click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("2");
  await expect(bell.getByTestId("attention-badge")).toHaveText("1");
  await expect(card.getByTestId("thread-snoozed")).toHaveText(/^Snoozed until (\w{3} )?\d{1,2}:\d\d [AP]M$/);
  // Reconnecting unsnoozes (the daemon's rule).
  await card.getByTestId("reconnect").click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("1");
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
  // cmd+shift+a never lands on a snoozed thread (s-8 waits, but is snoozed).
  await page.getByTestId("snoozed-header").click();
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
});

test("the palette's Snooze opens the custom dialog for the selected thread", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Snooze or Unsnooze");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("snooze-dialog")).toBeVisible();
  await expect(page.getByTestId("snooze-dialog")).toHaveAttribute("data-session", "s-3");
  await page.getByTestId("snooze-dialog").getByTestId("snooze-submit").click();
  await expect(page.getByTestId("snoozed-count")).toHaveText("3");
});
