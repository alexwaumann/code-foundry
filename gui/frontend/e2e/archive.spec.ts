import { expect, test, type Page } from "@playwright/test";
import { holdThreads, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

// Archived threads in the sidebar (docs/notes/archive-threads-2-sidebar.md). The default
// world has one archived thread, s-7 ("Spike a canvas sidebar", archived 90 min ago); the
// Archived section is collapsed by default.

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

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  });
}

function scrollState(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
}

async function openMenu(page: Page, key: string) {
  await row(page, key).click({ button: "right" });
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("Archived section: collapsed by default with its count; expanded, single-line rows with the archive age; hidden with no archived thread", async ({ page }) => {
  await openApp(page);
  const header = page.getByTestId("archived-header");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("archived-label")).toHaveText("Archived");
  await expect(page.getByTestId("archived-count")).toHaveText("1");
  await expect(header).toHaveAccessibleName("Archived 1");
  await expect(row(page, "h:archived")).toHaveAttribute("role", "presentation");
  await expect(row(page, "s:s-7")).toHaveCount(0);
  // Below Working, last in the list.
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "# Archived 1"]);
  expect((await box(page, "sidebar-archived")).top).toBeGreaterThanOrEqual((await box(page, "sidebar-working")).bottom - 0.5);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const archived = row(page, "s:s-7");
  await expect(archived).toBeVisible();
  await expect(archived).toHaveAttribute("data-section", "archived");
  await expect(archived.getByTestId("thread-name")).toHaveText("Spike a canvas sidebar");
  await expect(archived.getByTestId("row-archived-age")).toHaveText("1h");
  // One line: no status line; quiet (regular weight), and the age has no icon.
  await expect(archived.getByTestId("row-line-1")).toHaveCount(0);
  await expect(archived.getByTestId("thread-name")).toHaveCSS("font-weight", "400");
  await expect(row(page, "s:s-2").getByTestId("thread-name")).toHaveCSS("font-weight", "500");
  await expect(archived.getByTestId("row-archived-age").locator("svg")).toHaveCount(0);

  // Hover: the same tooltip as other rows.
  await archived.hover();
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId("tip-name")).toHaveText("Spike a canvas sidebar");
  await page.mouse.move(900, 400);

  // Expanded survives a reload (persisted with the other sidebar prefs).
  await page.reload();
  await expect(page.getByTestId("archived-header")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "s:s-7")).toBeVisible();

  // Unarchived (as from the CLI): no archived thread, no section; s-7 is back in the main list.
  await mockPost("thread/archive?id=s-7&archived=false");
  await expect(page.getByTestId("sidebar-archived")).toHaveCount(0);
  await expect(page.getByTestId("archived-header")).toHaveCount(0);
  await expect(row(page, "s:s-7")).toHaveAttribute("data-section", "done");

  // Collapsing again from the keyboard: the header is a button.
  await mockPost("thread/archive?id=s-7");
  await expect(page.getByTestId("archived-count")).toHaveText("1");
  await page.getByTestId("archived-header").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("archived-header")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "s:s-7")).toHaveCount(0);
});

// Archive and Unarchive in the row menu, their thread.archive, and the Archived section's order and age:
// unit-tested in src/components/thread/ThreadMenuItems.test.tsx, src/stores/threadActions.test.ts,
// src/lib/tree.test.ts and src/components/sidebar/SidebarRow.test.tsx (the daemon asks only mid-turn).

test("archiving a working thread asks first (the daemon's confirmation); it then drops its side panel and bottom panel", async ({ page }) => {
  await openApp(page);
  // s-1 is busy and owns t-s1-shell; open its bottom panel and a side panel tab.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await page.getByTestId("thread-header").getByTestId("bottom-toggle").click();
  await expect(page.getByTestId("bottom-panel")).toBeVisible();
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.openSurface("current", m.makeTab("files", "Files")))`);
  await expect(page.getByTestId("side-panel")).toBeVisible();

  // The title menu's Archive: the mock, like the daemon, asks while Claude is working.
  await page.getByTestId("thread-header").getByTestId("thread-title").click();
  await page.getByTestId("thread-title-menu").getByTestId("menu-archive").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Claude is still working; archiving ends the turn.");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("archived-count")).toHaveText("2");
  await expect(page.getByTestId("working-count")).toHaveText("1");
  await expect(row(page, "s:s-1")).toHaveCount(0);
  // It was the selected thread, so the window lands home, the No project composer (#119,
  // docs/notes/put-away-focuses-dashboard.md, remove-dashboard.md).
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build with No project?");
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await expect(page.getByTestId("bottom-panel")).toHaveCount(0);
  expect(
    await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.usePanelStore.getState().byKey["thread:s-1"])`),
  ).toEqual({ open: false, groups: [{ tabs: [], activeTabId: null }] });
  // Opened again from the Archived section: its composer, and neither panel comes back.
  await page.getByTestId("archived-header").click();
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await expect(page.getByTestId("thread-composer")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await expect(page.getByTestId("bottom-panel")).toHaveCount(0);
  // The title menu now unarchives.
  await page.getByTestId("thread-header").getByTestId("thread-title").click();
  await expect(page.getByTestId("thread-title-menu").getByTestId("menu-archive")).toHaveText("Unarchive");
  await page.keyboard.press("Escape");
  const confirmed = (await invocations()).filter((i) => i.name === "thread.archive");
  expect(confirmed.map((i) => i.confirmed)).toEqual([false, true]);

  // Archived from the CLI (another client): the same panel reset.
  await row(page, "s:s-2").click();
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.openSurface("current", m.makeTab("files", "Files")))`);
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await mockPost("thread/archive?id=s-2");
  await expect(page.getByTestId("archived-count")).toHaveText("3");
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
});

// The keyboard's one order across the main list and the footers: snooze.spec.ts.

test("the footers stay pinned under a long main list, are capped, and scroll their own rows to the cursor", async ({ page }) => {
  // 30 idle threads make the main list scroll; 12 busy ones overflow Working's cap.
  await mockPost("threads?project=repo-cf&count=30&status=idle&prefix=Idle");
  const busy = (await mockPost("threads?project=repo-cf&count=12&status=busy&prefix=Job")) as string[];
  await holdThreads(...busy);
  await openApp(page);
  await expect(page.getByTestId("working-count")).toHaveText("14");

  const main = await scrollState(page, "sidebar-main");
  expect(main.height).toBeGreaterThan(main.client);
  // Main list at the top, then at the bottom: the Working and Archived headers stay in view, in place.
  await page.getByTestId("sidebar-main").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByTestId("working-header")).toBeInViewport();
  await expect(page.getByTestId("archived-header")).toBeInViewport();
  const before = await box(page, "sidebar-working");
  await page.getByTestId("sidebar-main").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId("working-header")).toBeInViewport();
  expect(await box(page, "sidebar-working")).toEqual(before);
  // Stacked: main, then Working, then Archived, all inside the body.
  const mainBox = await box(page, "sidebar-main");
  expect(before.top).toBeGreaterThanOrEqual(mainBox.bottom - 0.5);
  expect((await box(page, "sidebar-archived")).top).toBeGreaterThanOrEqual(before.bottom - 0.5);

  // Working is capped at 40% of the sidebar body; its rows scroll inside it.
  const body = await box(page, "sidebar-body");
  expect(before.height).toBeLessThanOrEqual(Math.floor(body.height * 0.4) + 1);
  const rows = await scrollState(page, "sidebar-working-rows");
  expect(rows.height).toBeGreaterThan(rows.client);
  expect(rows.top).toBe(0);

  // End puts the cursor on Working's last row (Archived is collapsed): Working scrolls to it.
  await list(page).focus();
  await page.keyboard.press("End");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-1");
  await expect.poll(async () => (await scrollState(page, "sidebar-working-rows")).top).toBeGreaterThan(0);
  await expect(row(page, "s:s-1")).toBeInViewport();
  // Home: the main list scrolls back to its first row.
  await page.keyboard.press("Home");
  await expect.poll(async () => (await scrollState(page, "sidebar-main")).top).toBeLessThanOrEqual(4);
});

// Archiving, snoozing or removing the selected thread selecting home, another thread's leaving it: src/stores/archiveCleanup.test.ts ("selection"); the row menu's Archive and Remove are src/components/sidebar/RowMenu.test.tsx's, the confirm src/components/confirm/ConfirmDialog.test.tsx's.
