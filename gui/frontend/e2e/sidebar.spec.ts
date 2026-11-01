import { expect, test, type Page } from "@playwright/test";
import { expectAttention, mockPost, openApp, resetMock, row } from "./fixtures";

function list(page: Page) {
  return page.getByTestId("thread-list");
}

test.beforeEach(async () => {
  await resetMock();
});

// The menu pane's current page (New thread on a composer, Projects, Pull Requests):
// src/components/sidebar/Sidebar.test.tsx ("the menu pane"); the window opening on the No project
// composer: home.spec.ts; the removed dashboard ignored: src/stores/views.test.ts; the selection not
// restored on reload: src/stores/persisted.test.ts.

// The flat list's order, its headers, aria-label and no non-thread rows, Home/↓/Enter/End/↑ on the
// list: src/components/sidebar/Sidebar.test.tsx ("the thread list"); a workspace thread's line 1 and
// line 3: src/components/sidebar/SidebarRow.test.tsx; the order rules: src/lib/tree.test.ts.
test("the focused list takes real keys: Home, ↓ and Enter select; cmd+2 is the second row", async ({ page }) => {
  await openApp(page);
  await list(page).focus();
  await page.keyboard.press("Home");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-2");
  await page.keyboard.press("ArrowDown");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-6");
  await page.keyboard.press("Enter");
  await expect(row(page, "s:s-6")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+1");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+2");
  await expect(row(page, "s:s-6")).toHaveAttribute("aria-selected", "true");
});

// Pin and Unpin from the row menu (thread.pin's args and context, the row moving to the top with its
// glyph and back): src/components/sidebar/Sidebar.test.tsx ("the row menu").

// Run in from the row menu (the members, the current one disabled, thread.run-in's args and context,
// the row's queued move) and in the palette's picker; absent for a one-project thread:
// src/components/sidebar/RunIn.test.tsx. The palette offering it only for a workspace thread is the
// daemon's When (internal/command); queuing until idle and the new worktree are the daemon's
// (internal/store/thread runin_test.go).

// The Projects view removing a workspace, New thread from a project's page, Remove worktree with its context, no Remove on the main checkout: src/components/projects/WorkspacePage.test.tsx ("Remove workspace asks first…") and ProjectPage.test.tsx ("a checkout row's menu…", "the header's menu…"); the hover-shown terminal button is projects.spec.ts's.

// Status kinds: the order and sections (src/lib/tree.test.ts), each row's icon, word, tone and detail,
// the idle time muted, no time on waiting rows, the name never coloured (src/components/sidebar/SidebarRow.test.tsx),
// cmd+1..9 and cmd+shift+a's order (src/keys/bindings.test.ts), the title's count (src/stores/threads.test.ts).
test("status kinds: cmd+1 and cmd+shift+a through the keymap, and the window title's count", async ({ page }) => {
  await mockPost("status-kinds");
  await openApp(page);
  await list(page).focus();
  await page.keyboard.press("Meta+1");
  await expect(row(page, "s:s-k-plan")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-k-approval")).toHaveAttribute("aria-selected", "true");
  await expectAttention(page, 7);
});

// The header's count, aria and role, collapsing and expanding, the selection staying, the keyboard
// skipping hidden rows: src/components/sidebar/Sidebar.test.tsx ("the Working footer"); the persisted
// field: src/stores/persisted.test.ts; cmd+N skipping hidden rows: src/keys/bindings.test.ts.
test("Working section: the header sits on the rows' edge; cmd+4/cmd+5 skip hidden rows; collapsed survives a reload; Space toggles", async ({ page }) => {
  await openApp(page);
  const header = page.getByTestId("working-header");
  // Same left edge as the rows (the 8px gutter rule): the header button starts where s-3 starts.
  const hb = await header.boundingBox();
  const rb = await row(page, "s:s-3").boundingBox();
  expect(hb?.x).toBe(rb?.x);
  expect(hb?.width).toBe(rb?.width);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Meta+4");
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+5");
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "s:s-2")).toBeVisible();
  await expect(row(page, "s:s-1")).toHaveCount(0);

  // From the keyboard: the header is a button (Space toggles it).
  await page.getByTestId("working-header").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Meta+5");
  await expect(row(page, "s:s-5")).toHaveAttribute("aria-selected", "true");
});

test("thread rows sit 4px apart at both densities, each row's box (and its selection) the row's own height", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await expect(page.getByTestId("sidebar-snoozed-rows").locator("[data-row-key]")).toHaveCount(2);
  const gaps = async (a: string, b: string) => {
    const [ra, rb] = [await row(page, a).boundingBox(), await row(page, b).boundingBox()];
    return { height: ra?.height, gap: Math.round(((rb?.y ?? 0) - ((ra?.y ?? 0) + (ra?.height ?? 0))) * 10) / 10 };
  };
  const snoozed = async () => {
    const keys = await page.getByTestId("sidebar-snoozed-rows").locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key") ?? ""));
    expect(keys).toHaveLength(2);
    return gaps(keys[0] ?? "", keys[1] ?? "");
  };
  // Thread rows are three lines (THREE_LINE_ROW, 60px) at both densities; snoozed rows one line by density.
  for (const [density, three, one] of [
    ["comfortable", 60, 32],
    ["compact", 60, 28],
  ] as const) {
    await mockPost(`settings/external?appearance.density=${density}`);
    await expect(page.locator("html")).toHaveAttribute("data-density", density);
    // Main list and the Working footer: three-line rows; Snoozed: one-line rows.
    await expect.poll(() => gaps("s:s-2", "s:s-6")).toEqual({ height: three, gap: 4 });
    expect(await gaps("s:s-5", "s:s-1")).toEqual({ height: three, gap: 4 });
    expect(await snoozed()).toEqual({ height: one, gap: 4 });
  }
  // The selection background is the row's own box: the gap under it stays the sidebar's.
  await row(page, "s:s-2").click();
  await expect(row(page, "s:s-2")).toHaveClass(/bg-cf-sidebar-row-selected/);
  const parent = await row(page, "s:s-2").evaluate((e) => (e.parentElement ? e.parentElement.getBoundingClientRect().height : 0));
  expect(parent).toBe(60);
  await mockPost("settings/external?appearance.density=");
});

test("the menu pane: under the band, gutter to edge, surface fill, divider border, pane radius, 4px inside; the threads 8px below", async ({ page }) => {
  await openApp(page);
  await expect(row(page, "s:s-2")).toBeVisible();
  await expect(page.getByTestId("sidebar-divider")).toHaveCount(0);
  const m = await page.evaluate(() => {
    const r = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    const [menu, band, body, sidebar, newThread, projects] = [r("sidebar-menu"), r("sidebar-band"), r("sidebar-body"), r("sidebar"), r("sidebar-new-thread"), r("nav-projects")];
    const first = document.querySelector('[data-testid="sidebar-main"] [role="option"]')?.getBoundingClientRect();
    const el = document.querySelector('[data-testid="sidebar-menu"]');
    const resolve = (prop: "backgroundColor" | "borderTopColor", v: string) => {
      const probe = document.createElement("div");
      probe.style.border = "1px solid";
      probe.style[prop] = v;
      document.body.append(probe);
      const c = getComputedStyle(probe)[prop];
      probe.remove();
      return c;
    };
    const cs = el ? getComputedStyle(el) : null;
    return {
      top: (menu?.top ?? 0) - (band?.bottom ?? 0),
      left: (menu?.left ?? 0) - (body?.left ?? 0),
      right: menu?.right === sidebar?.right,
      radius: cs?.borderTopLeftRadius,
      border: cs?.borderTopWidth,
      fill: cs?.backgroundColor === resolve("backgroundColor", "var(--cf-surface)"),
      edge: cs?.borderTopColor === resolve("borderTopColor", "var(--cf-divider)"),
      inset: [(newThread?.top ?? 0) - (menu?.top ?? 0), (newThread?.left ?? 0) - (menu?.left ?? 0), (menu?.bottom ?? 0) - (projects?.bottom ?? 0)],
      rows: [newThread?.height, projects?.height],
      below: (first?.top ?? 0) - (menu?.bottom ?? 0),
    };
  });
  // 12px gutter (pl-shell) on the left; 1px border + 4px padding to the rows; 8px gap plus the
  // list's 4px paddingStart to the first thread row.
  expect(m).toEqual({ top: 0, left: 12, right: true, radius: "12px", border: "1px", fill: true, edge: true, inset: [5, 5, 5], rows: [28, 28], below: 12 });
});

// The Working header counting threads as they start and stop, a pinned working thread on top, the
// header going with the last one: src/components/sidebar/Sidebar.test.tsx ("the Working footer").

// The card's content (name, project with where it runs, branch, chips, model and effort, no git):
// src/components/sidebar/SidebarRow.test.tsx ("SidebarRow card").
test("hovering a thread row shows its card right of the sidebar, 260px wide; a click or right-click closes it, the keyboard never opens it", async ({ page }) => {
  await openApp(page);
  // The open one: the previous tooltip may still be fading out.
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  await row(page, "s:s-3").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-3");
  const sidebar = await page.getByTestId("sidebar").boundingBox();
  const box = await tip.boundingBox();
  expect(box && sidebar && box.x >= sidebar.x + sidebar.width - 1).toBe(true);
  expect(Math.round(box?.width ?? 0)).toBe(260);
  // Moving to the next row moves the card.
  await row(page, "s:s-2").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-2");

  // A click closes it and selects the row; the keyboard never opens one.
  await row(page, "s:s-2").click();
  await expect(tip).toHaveCount(0);
  await page.mouse.move(900, 600);
  await list(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  await expect(tip).toHaveCount(0);

  // A right-click closes it and opens the row menu.
  await row(page, "s:s-1").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-1");
  await row(page, "s:s-1").click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(tip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("row-menu")).toHaveCount(0);
});

// A multi-project thread's card (workspace or N projects, the run-in project and where it runs, branch, model) and line 1: src/components/sidebar/SidebarRow.test.tsx ("a workspace thread…", "an unnamed set…", "a thread in its workspace's folder…", "line 1 of a multi-project thread").

// The status line's words, tones and times for every kind, and none for working or idle:
// src/components/sidebar/SidebarRow.test.tsx ("SidebarRow card status time").
test("a long permission prompt: line 3 cuts it off; the card wraps all of it between the name and the project", async ({ page }) => {
  await mockPost("status-kinds");
  const long = "Do you want to create hello.txt in the scratch repository and then run the whole test suite?";
  await mockPost(`thread/status?id=s-k-approval&status=attention&reason=${encodeURIComponent(`permission: ${long}`)}`);
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  const approval = row(page, "s:s-k-approval");
  await expect(approval.getByTestId("row-detail")).toHaveText(long);
  expect(await approval.getByTestId("row-detail").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await approval.hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-k-approval");
  const status = tip.getByTestId("tip-status");
  await expect(status).toContainText(long);
  expect(Math.round((await tip.boundingBox())?.width ?? 0)).toBe(260);
  const [name, st, project] = [await tip.getByTestId("tip-name").boundingBox(), await status.boundingBox(), await tip.getByTestId("tip-project").boundingBox()];
  expect(st && st.height >= 40).toBe(true);
  expect(name && st && project && name.y < st.y && st.y + st.height <= project.y).toBe(true);
});
