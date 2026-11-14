import { expect, test, type Locator, type Page } from "@playwright/test";
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

// The Projects view removing a workspace, New thread from a project's page, Remove worktree with its context, no Remove on the main checkout: src/components/projects/WorkspacePage.test.tsx ("Remove workspace asks first…") and ProjectPage.test.tsx ("a checkout row's menu…", "the header's menu…").

// Status kinds: the order and sections (src/lib/tree.test.ts), each row's icon, word, tone and detail,
// the idle time muted, no time on waiting rows, the name never coloured (src/components/sidebar/SidebarRow.test.tsx),
// cmd+1..9 and cmd+shift+a's order (src/keys/bindings.test.ts), the title's count (src/stores/threads.test.ts).
test("status kinds: cmd+1 and cmd+shift+a through the keymap, and the window title's count", async ({ page }) => {
  await mockPost("status-kinds");
  await openApp(page);
  await list(page).focus();
  // cmd+1 opens the list's first row, a Needs you row (the plan waiting for approval); cmd+shift+a
  // opens the popup of Needs you's next thread after it (shell-model.md, Keys).
  await page.keyboard.press("Meta+1");
  await expect(row(page, "s:s-k-plan")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-k-plan");
  await page.keyboard.press("Meta+Shift+a");
  await expect(page.getByTestId("needs-popup")).toHaveAttribute("data-thread-id", "s-k-approval");
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

// The shell's rows (sidebar/shell/ShellSidebarList.tsx): a thread row is as tall as its lines (the
// title wraps to two, the branch line only when there is one: lib/shellSections.test.ts, ShellRows),
// a Snoozed or Archived row one 24px line.
test("thread rows sit 8px apart, snoozed rows 2px and 24px tall, at both densities, each row's box (and its selection) the row's own height", async ({ page }) => {
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
  // The row's box is its slot in the list: the slot (the virtual item) is exactly the row's height.
  const ownHeight = (key: string) => row(page, key).evaluate((e) => (e.parentElement ? e.parentElement.getBoundingClientRect().height : 0) - e.getBoundingClientRect().height);
  for (const density of ["comfortable", "compact"] as const) {
    await mockPost(`settings/external?appearance.density=${density}`);
    await expect(page.locator("html")).toHaveAttribute("data-density", density);
    // Active and the Working footer: 8px apart; Snoozed: one-line rows 2px apart.
    await expect.poll(async () => (await gaps("s:s-6", "s:s-4")).gap).toBe(8);
    expect((await gaps("s:s-5", "s:s-1")).gap).toBe(8);
    expect(await snoozed()).toEqual({ height: 24, gap: 2 });
    for (const key of ["s:s-2", "s:s-6", "s:s-5"]) expect(await ownHeight(key), key).toBe(0);
  }
  // The selection background is the row's own box: the gap under it stays the sidebar's.
  await row(page, "s:s-6").click();
  await expect(row(page, "s:s-6")).toHaveClass(/bg-cf-sidebar-row-selected/);
  expect(await ownHeight("s:s-6")).toBe(0);
  expect((await gaps("s:s-6", "s:s-4")).gap).toBe(8);
  await mockPost("settings/external?appearance.density=");
});

test("a snoozed row's text is at 60% until hovered, selected or under the cursor; its background never dims", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  const rows = page.getByTestId("sidebar-snoozed-rows").locator("[data-row-key]");
  await expect(rows).toHaveCount(2);
  const [first, second] = [rows.nth(0), rows.nth(1)];
  const opacity = (r: Locator) => r.getByTestId("thread-body").evaluate((e) => getComputedStyle(e).opacity);
  await page.mouse.move(640, 400);
  await expect.poll(() => opacity(first)).toBe("0.6");
  await first.hover();
  await expect.poll(() => opacity(first)).toBe("1");
  expect(await first.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  await first.click();
  await page.mouse.move(640, 400);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => opacity(first)).toBe("1");
  await page.getByTestId("thread-list").focus();
  await page.keyboard.press("ArrowDown");
  await expect(second).toHaveAttribute("data-cursor", "true");
  await expect.poll(() => opacity(second)).toBe("1");
});

// The band and the Pull Requests and Projects rows are gone (they are tabs: the "+" menu and the
// palette); the menu pane keeps New thread under the top bar.
test("the menu pane: under the top bar, gutter to edge, surface fill, divider border, pane radius, 4px inside; the list 8px below", async ({ page }) => {
  await openApp(page);
  await expect(row(page, "s:s-2")).toBeVisible();
  await expect(page.getByTestId("sidebar-divider")).toHaveCount(0);
  const m = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
    const [menu, bar, body, sidebar, newThread] = [r('[data-testid="sidebar-menu"]'), r('[data-testid="top-bar"]'), r('[data-testid="sidebar-body"]'), r('[data-testid="sidebar"]'), r('[data-testid="sidebar-new-thread"]')];
    const first = r('[data-testid="thread-list"] [data-row-key]');
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
      top: (menu?.top ?? 0) - (bar?.bottom ?? 0),
      left: (menu?.left ?? 0) - (body?.left ?? 0),
      right: menu?.right === sidebar?.right,
      radius: cs?.borderTopLeftRadius,
      border: cs?.borderTopWidth,
      fill: cs?.backgroundColor === resolve("backgroundColor", "var(--cf-surface)"),
      edge: cs?.borderTopColor === resolve("borderTopColor", "var(--cf-divider)"),
      inset: [(newThread?.top ?? 0) - (menu?.top ?? 0), (newThread?.left ?? 0) - (menu?.left ?? 0), (menu?.bottom ?? 0) - (newThread?.bottom ?? 0)],
      rows: [newThread?.height],
      below: (first?.top ?? 0) - (menu?.bottom ?? 0),
    };
  });
  // 12px gutter (pl-shell) on the left; 1px border + 4px padding to New thread; 8px (mb-2) to the
  // list's first row (the Needs you header here).
  expect(m).toEqual({ top: 0, left: 12, right: true, radius: "12px", border: "1px", fill: true, edge: true, inset: [5, 5, 5], rows: [28], below: 8 });
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
  // Moving to the next row moves the card (a Needs you row, s-2's, has the inbox's card instead:
  // e2e/shell-needs.spec.ts).
  await row(page, "s:s-4").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-4");

  // A click closes it and opens the thread; the keyboard never opens one.
  await row(page, "s:s-4").click();
  await expect(tip).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-4");
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

test("a real pointer keeps the card open over the row's actions and PR tag", async ({ page }) => {
  await mockPost(`link-pr?thread=s-3&slug=${encodeURIComponent("alexwaumann/code-foundry")}&number=145&ago=60000`);
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  const r = row(page, "s:s-3");
  await r.getByTestId("thread-name").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-3");
  for (const id of ["row-snooze", "row-archive", "row-linked-prs"]) {
    await r.getByTestId(id).hover();
    await page.waitForTimeout(100);
    await expect(tip).toHaveAttribute("data-thread-id", "s-3");
  }
});

// The shell's row puts the hover controls in line 1, in the status's slot (e2e/shell-sidebar.spec.ts
// "on hover the snooze and archive controls take the status's slot in line 1"); the branch has line 3
// to itself. Here: at the narrowest sidebar, on a selected row too, with a long branch.
test("at the narrowest sidebar the actions never cover the branch, on a selected row too, and the name and status stay", async ({ page }) => {
  await openApp(page);
  // The default width is the minimum (SIDEBAR_MIN).
  expect((await page.getByTestId("sidebar").boundingBox())?.width).toBe(240);
  for (const select of [false, true]) {
    const r = row(page, "s:s-3");
    if (select) await r.click();
    if (select) await expect(r).toHaveAttribute("aria-selected", "true");
    await r.getByTestId("row-branch").evaluate((el) => {
      el.textContent = "cf/a-branch-name-long-enough-to-run-under-the-actions";
    });
    await page.mouse.move(700, 450);
    const nameBefore = await r.getByTestId("thread-name").boundingBox();
    await r.getByTestId("thread-name").hover();
    await expect(r.getByTestId("row-actions")).toHaveCSS("opacity", "1");
    const [branch, actions, line1, line3, project, name, box] = await Promise.all(
      ["row-branch", "row-actions", "row-line-1", "row-line-3", "row-project", "thread-name"].map((id) => r.getByTestId(id).boundingBox()).concat(r.boundingBox()),
    );
    if (!branch || !actions || !line1 || !line3 || !project || !name || !box) throw new Error("no layout");
    // The actions sit in line 1, at its right end; the branch is on line 3, below them, inside the row.
    expect(Math.abs(actions.y + actions.height / 2 - (line1.y + line1.height / 2))).toBeLessThanOrEqual(1);
    expect(branch.y).toBeGreaterThanOrEqual(actions.y + actions.height);
    expect(branch.x + branch.width).toBeLessThanOrEqual(box.x + box.width);
    expect(line3.y).toBeGreaterThan(line1.y + line1.height);
    // The project stays (cut short) left of the actions, and the name does not move.
    expect(project.width).toBeGreaterThan(0);
    expect(project.x + project.width).toBeLessThanOrEqual(actions.x);
    expect(name).toEqual(nameBefore);
  }
  // A Needs you row has no hover controls: its ask stays.
  await row(page, "s:s-2").getByTestId("thread-name").hover();
  await expect(row(page, "s:s-2").getByTestId("row-ask")).toHaveCSS("visibility", "visible");
  await expect(row(page, "s:s-2").getByTestId("row-actions")).toHaveCount(0);
});

// A multi-project thread's card (workspace or N projects, the run-in project and where it runs, branch, model) and line 1: src/components/sidebar/SidebarRow.test.tsx ("a workspace thread…", "an unnamed set…", "a thread in its workspace's folder…", "line 1 of a multi-project thread").

// The status line's words, tones and times for every kind, and none for working or idle:
// src/components/sidebar/SidebarRow.test.tsx ("SidebarRow card status time").
// "a long permission prompt: the row keeps its branch; the card wraps all of it between the name and the
// project": a thread asking is a Needs you row (project and ask, then the title; no branch line:
// shell-model.md, Sidebar) with the inbox's card, not the classic one. The card growing with a long ask
// up to its maximum and scrolling: e2e/shell-needs.spec.ts; what it shows: src/components/needs/NeedsCard.test.tsx.

/** SHOTS=<dir>: Snoozed and Archived open, 24px rows 2px apart under Working's 8px, WebKit, 1280x800 at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("the quiet sections' rows", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await mockPost("thread/archive?id=s-3");
      await mockPost("thread/archive?id=s-4");
      await mockPost("thread/snooze?id=s-6&until=2h");
      await openApp(page);
      await page.getByTestId("snoozed-header").click();
      await page.getByTestId("archived-header").click();
      await expect(page.getByTestId("sidebar-archived-rows").locator("[data-row-key]")).toHaveCount(3);
      await page.mouse.move(640, 400);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(shots)}/quiet-rows-tighter-${scheme}.png` });
    });
  });
}
