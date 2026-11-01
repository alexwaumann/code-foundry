import { expect, test, type Page } from "@playwright/test";
import { holdThreads, mockPost, openApp, resetMock, row } from "./fixtures";

// Archived threads in the sidebar (docs/notes/archive-threads-2-sidebar.md). The default
// world has one archived thread, s-7 ("Spike a canvas sidebar", archived 90 min ago); the
// Archived section is collapsed by default.

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

function scrollState(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
}

// The Archived header (collapsed by default, label, count, name, presentation), last in the list, the
// expanded one-line row with its age, the section going on unarchive and back on archive:
// src/components/sidebar/Sidebar.test.tsx ("the Snoozed and Archived footers"); the age without an icon:
// src/components/sidebar/SidebarRow.test.tsx; the card on hover is every row's (sidebar.spec.ts).
test("Archived section: below Working; a quiet row (regular weight); expanded survives a reload; Space on the header", async ({ page }) => {
  await openApp(page);
  expect((await box(page, "sidebar-archived")).top).toBeGreaterThanOrEqual((await box(page, "sidebar-working")).bottom - 0.5);
  const header = page.getByTestId("archived-header");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const archived = row(page, "s:s-7");
  await expect(archived.getByTestId("thread-name")).toHaveCSS("font-weight", "400");
  await expect(row(page, "s:s-2").getByTestId("thread-name")).toHaveCSS("font-weight", "500");
  await page.reload();
  await expect(page.getByTestId("archived-header")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "s:s-7")).toBeVisible();
  // Collapsing from the keyboard: the header is a button.
  await page.getByTestId("archived-header").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("archived-header")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "s:s-7")).toHaveCount(0);
});

// Archive and Unarchive in the row menu, their thread.archive, and the Archived section's order and age:
// unit-tested in src/components/thread/ThreadMenuItems.test.tsx, src/stores/threadActions.test.ts,
// src/lib/tree.test.ts and src/components/sidebar/SidebarRow.test.tsx (the daemon asks only mid-turn).

// Archiving a working thread from the title menu: the daemon asking only mid-turn (internal/command) and
// the retry confirmed (src/stores/commands.test.ts, src/components/confirm/ConfirmDialog.test.tsx); its
// side and bottom panels dropped, the window landing home, nothing coming back when it is opened again,
// whoever archived it (src/stores/archiveCleanup.test.ts); the title menu's Unarchive
// (src/components/thread/ThreadMenuItems.test.tsx); the counts (src/components/sidebar/Sidebar.test.tsx).

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
