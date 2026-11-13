import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectTooltip, infoCardOff, invocations, mockPost, openApp, openTooltip, resetMock, row, setZoom } from "./fixtures";
import { activeOfKind, paneWith } from "./shell-surfaces";

/**
 * The thread info card (docs/notes/thread-info-card.md) over the mock's
 * POST /__mock/thread-info scenarios (World.addThreadInfo): one project (s-ti-1), a nine
 * project workspace (s-ti-ws), the same thread working, a child thread and a thread in a
 * folder without git.
 */

const card = (page: Page) => page.getByTestId("thread-info-card");
const toggle = (page: Page) => page.getByTestId("thread-info-toggle");

async function openWithCard(page: Page, scenario: string): Promise<string> {
  const { id } = (await mockPost(`thread-info?scenario=${scenario}`)) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  return id;
}

test.beforeEach(async () => {
  await resetMock();
  // The card off for threads never toggled (on by default), so its toggle shows it.
  await infoCardOff();
});

// The card's rows, menus, stop squares, tabs it opens and the Branch copied toast:
// src/components/threadinfo/ThreadInfoCard.test.tsx ("ThreadInfoCard: one project").
test("one project: the toggle, the usage card's lines, an open fold's background, the card stepping aside for a pane beside, a reload", async ({ page }) => {
  const { id } = (await mockPost("thread-info?scenario=single")) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  // Off by the setting (infoCardOff); the toggle (view.thread-info) shows it beside the conversation and composer.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  const c = card(page);
  // Usage's hover card: each model's share sits on its cost's line, never wrapped under it.
  const usage = c.getByTestId("ti-usage");
  await page.mouse.move(0, 0);
  await usage.hover();
  const tip = openTooltip(page);
  await expect(tip.getByTestId("ti-usage-model-share")).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const [a, b] = await Promise.all([tip.getByTestId("ti-usage-model-cost").nth(i).boundingBox(), tip.getByTestId("ti-usage-model-share").nth(i).boundingBox()]);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? -100))).toBeLessThan(1);
  }
  await page.mouse.move(0, 0);

  // An open fold is not selected: with the pointer elsewhere it has a closed row's background, only its chevron says open.
  await usage.click();
  await expect(usage).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(0, 0);
  const bg = (l: typeof usage) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(async () => bg(usage)).toBe(await bg(c.getByTestId("ti-context")));

  // At 1280px the diff's pane beside leaves the conversation too little room: the card steps aside
  // (it floats on demand there: shell-linked.spec.ts) until the diff's tab closes.
  await c.getByTestId("ti-changes").click();
  await expect(activeOfKind(page, "diff")).toHaveCount(1);
  await expect(page.getByTestId("thread-info-card")).toHaveCount(0);
  await paneWith(page, "diff").getByTestId("shell-tab-close").click();
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);
  await expect(card(page)).toBeVisible();

  // The toggle is the window's: it stays on through a reload, and off hides the card.
  await page.reload();
  await row(page, `s:${id}`).click();
  await expect(card(page)).toBeVisible();
  await toggle(page).click();
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
});

/** A locator's right edge. */
async function rightOf(l: Locator): Promise<number> {
  const b = await box(l);
  return b.x + b.width;
}

/** A pseudo-element's background colour. */
function pseudoBg(l: Locator, pseudo: "::before" | "::after"): Promise<string> {
  return l.evaluate((el, p) => getComputedStyle(el, p).backgroundColor, pseudo);
}

/** An element's own background colour. */
function ownBg(l: Locator): Promise<string> {
  return l.evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** The split hover's colours as the page computes them: no tint, the full tint, the half tint (Tailwind's `/50`), the bright glyph. */
async function splitBlocks(page: Page): Promise<{ none: string; full: string; half: string; text: string }> {
  return page.evaluate(() => {
    const probe = (prop: "backgroundColor" | "color", value: string) => {
      const d = document.createElement("div");
      d.style[prop] = value;
      document.body.append(d);
      const c = getComputedStyle(d)[prop];
      d.remove();
      return c;
    };
    return {
      none: probe("backgroundColor", "transparent"),
      full: probe("backgroundColor", "var(--cf-control-hover)"),
      half: probe("backgroundColor", "color-mix(in oklab, var(--cf-control-hover) 50%, transparent)"),
      text: probe("color", "var(--cf-text)"),
    };
  });
}

/** The menu sits under its row at the row's width, once its open animation ends. */
async function expectUnderRow(menu: Locator, rowEl: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [m, r] = await Promise.all([box(menu), box(rowEl)]);
      return [Math.round(m.x - r.x), Math.round(m.width - r.width), m.y >= r.y + r.height];
    })
    .toEqual([0, 0, true]);
}

test("split rows: a click runs the row, the ellipsis opens its menu under the row; values, ellipses and chevrons share one right edge", async ({ page }) => {
  // Wide enough that the card stays beside the conversation once Open in › Terminal opens a terminal tab beside the thread.
  await page.setViewportSize({ width: 2200, height: 900 });
  await openWithCard(page, "single");
  const c = card(page);
  const openIn = c.getByTestId("ti-open-in");
  const action = c.getByTestId("ti-action");
  const pr = c.getByTestId("ti-pr").first();
  await expect(action).toContainText("Dev");

  // A chevron only on a disclosure: the split rows carry an ellipsis instead, rows without either reserve nothing.
  for (const id of ["ti-open-in", "ti-action", "ti-pr", "ti-context", "ti-branch", "ti-lineage-label"]) await expect(c.getByTestId(`${id}-chevron`)).toHaveCount(0);
  await expect(openIn.getByTestId("ti-open-in-more")).toHaveAttribute("aria-label", "Open in options");
  await expect(action.getByTestId("ti-action-more")).toHaveAttribute("aria-label", "Actions options");
  await expect(pr.getByTestId("ti-pr-more")).toHaveAttribute("aria-label", "Pull request options");

  // One right edge, the row's padding inside its own: values without a chevron, every ellipsis, every chevron.
  const edge = (await rightOf(c.getByTestId("ti-context"))) - 4;
  const ends = [
    "ti-context-meta",
    "ti-branch-meta",
    "ti-open-in-more",
    "ti-action-more",
    "ti-pr-more",
    "ti-project-chevron",
    "ti-previous-chevron",
    "ti-mcp-chevron",
    "ti-usage-chevron",
  ];
  for (const id of ends) expect(Math.abs((await rightOf(c.getByTestId(id).first())) - edge), id).toBeLessThan(1);
  // The ellipsis glyph is the chevron's 16px box.
  const more = await box(c.getByTestId("ti-open-in-more"));
  const chev = await box(c.getByTestId("ti-project-chevron"));
  expect([more.width, more.height]).toEqual([chev.width, chev.height]);

  // The split hover (docs/notes/thread-info-split-hover.md): the row's ::before is the left
  // block, the ellipsis's ::after the right one (the last 24px, the row's full height, the
  // click target); a 2px seam between them. The row itself has no tint.
  const openInMore = c.getByTestId("ti-open-in-more");
  const blocks = await splitBlocks(page);
  expect(new Set([blocks.none, blocks.full, blocks.half]).size).toBe(3);
  const lit = (rowEl: Locator, moreEl: Locator) => Promise.all([pseudoBg(rowEl, "::before"), pseudoBg(moreEl, "::after"), ownBg(rowEl)]);
  for (const [rowEl, moreEl] of [
    [openIn, openInMore],
    [pr, pr.getByTestId("ti-pr-more")],
  ] as const) {
    const [r, m] = await Promise.all([box(rowEl), box(moreEl)]);
    const geo = await moreEl.evaluate((el) => {
      const a = getComputedStyle(el, "::after");
      const b = getComputedStyle(el.closest("[data-ti-row]") ?? el, "::before");
      return { w: a.width, h: a.height, right: a.right, top: a.top, gap: b.right };
    });
    expect(geo).toEqual({ w: "24px", h: `${String(r.height)}px`, right: "0px", top: "0px", gap: "26px" });
    // The glyph sits inside its block: the hit area did not shrink.
    expect(m.x + m.width).toBeLessThanOrEqual(r.x + r.width);
    expect(m.x).toBeGreaterThanOrEqual(r.x + r.width - 24);
  }
  await page.mouse.move(0, 0);
  expect(await lit(openIn, openInMore)).toEqual([blocks.none, blocks.none, blocks.none]);
  // The text under the pointer: the left block bright, the ellipsis dim.
  await openIn.hover({ position: { x: 30, y: 10 } });
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.full, blocks.half, blocks.none]);
  // The ellipsis under the pointer: flipped.
  await openInMore.hover();
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.half, blocks.full, blocks.none]);
  await expect.poll(() => openInMore.evaluate((el) => getComputedStyle(el).color)).toBe(blocks.text);
  // A tall pull request row, both lines: the same two blocks.
  const prMore = pr.getByTestId("ti-pr-more");
  await pr.hover({ position: { x: 30, y: 10 } });
  await expect.poll(() => lit(pr, prMore)).toEqual([blocks.full, blocks.half, blocks.none]);
  await prMore.hover();
  await expect.poll(() => lit(pr, prMore)).toEqual([blocks.half, blocks.full, blocks.none]);

  const reveals = async () => (await invocations()).filter((i) => i.name === "worktree.reveal").length;
  // Open in: the ellipsis opens the menu under the row, at its width, and reveals nothing.
  // While it is up only the ellipsis block is lit, wherever the pointer is.
  await openInMore.click();
  const openInMenu = page.getByTestId("ti-open-in-menu");
  await expect(openInMenu).toBeVisible();
  await expect(openInMore).toHaveAttribute("aria-expanded", "true");
  await expectUnderRow(openInMenu, openIn);
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.none, blocks.full, blocks.none]);
  await openIn.hover({ position: { x: 30, y: 10 } });
  await expect(openInMenu).toBeVisible();
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.none, blocks.full, blocks.none]);
  await page.mouse.move(0, 0);
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.none, blocks.full, blocks.none]);
  await expect.poll(() => openInMore.evaluate((el) => getComputedStyle(el).color)).toBe(blocks.text);
  await expect(openInMenu.getByTestId("ti-open-finder")).toBeVisible();
  // A menu item is the item's, not the row's click too (React bubbles portal events to the row).
  await openInMenu.getByTestId("ti-open-terminal").click();
  await expect(openInMenu).toHaveCount(0);
  // Its terminal opens as a tab linked to the thread, beside it.
  await expect(activeOfKind(page, "terminal")).toHaveCount(1);
  expect(await reveals()).toBe(0);
  // The row's click reveals; Enter on the row too; Tab reaches the ellipsis, whose Enter opens the menu.
  await openIn.click();
  await expect.poll(reveals).toBe(1);
  await openIn.focus();
  await page.keyboard.press("Enter");
  await expect.poll(reveals).toBe(2);
  await page.mouse.move(0, 0);
  await page.keyboard.press("Tab");
  await expect(c.getByTestId("ti-open-in-more")).toBeFocused();
  // Keyboard focus on the ellipsis lights its block only.
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.none, blocks.full, blocks.none]);
  await page.keyboard.press("Shift+Tab");
  await expect(openIn).toBeFocused();
  // On the row: the left block only.
  await expect.poll(() => lit(openIn, openInMore)).toEqual([blocks.full, blocks.none, blocks.none]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(openInMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(openInMenu).toHaveCount(0);
  expect(await reveals()).toBe(2);
  // Escape hands focus back to the ellipsis, so Tab goes on to the next row.
  await expect(c.getByTestId("ti-open-in-more")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(action).toBeFocused();
  // A chevron row's menu gives it back to the row.
  await c.getByTestId("ti-project").click();
  await expect(page.getByTestId("ti-project-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(c.getByTestId("ti-project")).toBeFocused();

  // The row buttons are named by their text and value, not by the ellipsis inside them.
  await expect(c.getByRole("button", { name: "Open in Finder", exact: true })).toHaveAttribute("data-testid", "ti-open-in");
  await expect(c.getByRole("button", { name: "Open in options", exact: true })).toHaveAttribute("data-testid", "ti-open-in-more");
  await expect(c.getByRole("button", { name: "Dev", exact: true })).toHaveAttribute("data-testid", "ti-action");
  await expect(c.getByRole("button", { name: /^Changes \+42/ })).toHaveAttribute("data-testid", "ti-changes");

  // A run re-reads the action picks (their key carries the newest run): the row keeps its
  // action meanwhile, the same element throughout (never the "Actions" row, which would
  // remount it, flash and drop its focus). The run's terminal tab: the test after this one.
  const runs = async () => (await invocations()).filter((i) => i.name === "action.run").length;
  await action.evaluate((el) => {
    el.setAttribute("data-mark", "");
    const seen: string[] = [];
    (window as unknown as { actionTexts: string[] }).actionTexts = seen;
    new MutationObserver(() => {
      const row = document.querySelector('[data-testid="thread-info-card"] [data-testid="ti-action"]');
      seen.push(row?.textContent ?? "");
    }).observe(document.querySelector('[data-testid="thread-info-card"]') ?? document.body, { subtree: true, childList: true, characterData: true });
  });
  for (const n of [1, 2]) {
    await action.focus();
    await page.keyboard.press("Enter");
    await expect.poll(runs).toBe(n);
  }
  await page.waitForTimeout(300);
  await expect(c.locator('[data-testid="ti-action"][data-mark]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { actionTexts: string[] }).actionTexts.filter((t) => !t.includes("Dev")))).toEqual([]);

  // The action: the ellipsis lists the actions and runs none.
  await c.getByTestId("ti-action-more").click();
  const actionMenu = page.getByTestId("ti-action-menu");
  await expect(actionMenu).toBeVisible();
  await expectUnderRow(actionMenu, action);
  await page.keyboard.press("Escape");
  expect(await runs()).toBe(2);

  // A pull request (a taller row): the ellipsis offers GitHub and Copy URL, and opens no tab.
  await pr.getByTestId("ti-pr-more").click();
  const prMenu = page.getByTestId("ti-pr-menu");
  await expect(prMenu.getByTestId("ti-pr-github")).toBeVisible();
  await expectUnderRow(prMenu, pr);
  await expect(page.locator('[data-testid="shell-tab"][data-kind="pullrequest"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("an action run from the card shows its terminal as a tab beside the thread, with the keyboard in it", async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 900 });
  await openWithCard(page, "single");
  const action = card(page).getByTestId("ti-action");
  await expect(action).toContainText("Dev");
  await action.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "action.run").length).toBe(1);
  await expect(activeOfKind(page, "terminal")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-terminal-host]") !== null)).toBe(true);
});

test("the action menu: the gear's blocks, the item hovers as two blocks, arrows move the focus between item and gear", async ({ page }) => {
  await openWithCard(page, "single");
  const c = card(page);
  await c.getByTestId("ti-action-more").click();
  const menu = page.getByTestId("ti-action-menu");
  await expect(menu).toBeVisible();
  const items = menu.getByTestId("ti-action-item");
  const item = (name: string) => items.filter({ hasText: name });
  const gear = (name: string) => item(name).getByTestId("ti-action-gear");
  const opacities = () => items.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector("[data-action-gear]") ?? el).opacity));
  // A gear in every item, Add action without one, its label: ThreadInfoCard.test.tsx ("the action menu").
  await expect(gear("Test")).toBeVisible();

  // The docs/notes/thread-info-action-menu-gear.md geometry: the gear's ::after is the
  // item's last 32px at its full height, the item's ::before ends 34px short (the seam);
  // the 16px glyph sits on the item's right padding line, centred in its block.
  const testItem = item("Test");
  // After the menu's open animation (it scales the content).
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const [ib, gb] = await Promise.all([box(testItem), box(gear("Test"))]);
  const geo = await gear("Test").evaluate((el) => {
    const a = getComputedStyle(el, "::after");
    const b = getComputedStyle(el.closest("[role=menuitem]") ?? el, "::before");
    return { w: a.width, h: a.height, right: a.right, top: a.top, gap: b.right, left: b.left };
  });
  expect(geo).toEqual({ w: "32px", h: `${String(ib.height)}px`, right: "0px", top: "0px", gap: "34px", left: "0px" });
  expect([gb.width, gb.height]).toEqual([16, 16]);
  expect(Math.round(ib.x + ib.width - (gb.x + gb.width))).toBe(8);

  const blocks = await splitBlocks(page);
  const lit = (name: string) => Promise.all([pseudoBg(item(name), "::before"), pseudoBg(gear(name), "::after"), ownBg(item(name))]);
  // The text under the pointer: left bright, gear dim; the gear shows on that item only.
  await testItem.hover({ position: { x: 30, y: 10 } });
  await expect(testItem).toHaveAttribute("data-highlighted", "");
  await expect.poll(() => lit("Test")).toEqual([blocks.full, blocks.half, blocks.none]);
  await expect.poll(opacities).toEqual(["0", "1", "0", "0", "0", "0"]);
  expect(await lit("Dev")).toEqual([blocks.none, blocks.none, blocks.none]);
  // The gear under the pointer: flipped, the glyph full colour.
  await gear("Test").hover();
  await expect.poll(() => lit("Test")).toEqual([blocks.half, blocks.full, blocks.none]);
  await expect.poll(() => gear("Test").evaluate((el) => getComputedStyle(el).color)).toBe(blocks.text);

  // Keyboard: ArrowDown highlights the next item and shows its gear (left bright, gear dim);
  // ArrowRight focuses the gear (flipped), ArrowLeft gives focus back.
  await page.mouse.move(0, 0);
  await testItem.focus();
  await page.keyboard.press("ArrowDown");
  const check = item("Check");
  await expect(check).toBeFocused();
  await expect.poll(opacities).toEqual(["0", "0", "1", "0", "0", "0"]);
  await expect.poll(() => lit("Check")).toEqual([blocks.full, blocks.half, blocks.none]);
  await page.keyboard.press("ArrowRight");
  await expect(gear("Check")).toBeFocused();
  await expect.poll(() => lit("Check")).toEqual([blocks.half, blocks.full, blocks.none]);
  await expect.poll(opacities).toEqual(["0", "0", "1", "0", "0", "0"]);
  await page.keyboard.press("ArrowLeft");
  await expect(check).toBeFocused();
  await expect.poll(() => lit("Check")).toEqual([blocks.full, blocks.half, blocks.none]);
  // ArrowDown from the gear moves on as from its item.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(item("Build")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(check).toBeFocused();

  await page.keyboard.press("Escape");
  // A gear click or Enter on a focused gear opens that action's editor and runs nothing; the
  // item's text runs it: ThreadInfoCard.test.tsx ("the action menu") and GearMenuItem.test.tsx.
});

for (const zoom of [90, 125]) {
  test(`at ${String(zoom)}% zoom the row menus sit under their rows at the rows' width`, async ({ page }) => {
    // Wide enough that the card keeps its 480px of conversation at 125% (it steps aside otherwise).
    await page.setViewportSize({ width: 1700, height: 900 });
    await openWithCard(page, "single");
    await setZoom(page, zoom);
    const c = card(page);
    await expect(c).toBeVisible();
    // An ellipsis menu (measured offsets and width) and a chevron menu (Radix's trigger width).
    await c.getByTestId("ti-open-in-more").click();
    await expectUnderRow(page.getByTestId("ti-open-in-menu"), c.getByTestId("ti-open-in"));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ti-open-in-menu")).toHaveCount(0);
    await c.getByTestId("ti-project").click();
    await expectUnderRow(page.getByTestId("ti-project-menu"), c.getByTestId("ti-project"));
    await page.keyboard.press("Escape");
    // The gap under the row grows with the zoom, like every menu's.
    const pr = c.getByTestId("ti-pr").first();
    await pr.getByTestId("ti-pr-more").click();
    await expectUnderRow(page.getByTestId("ti-pr-menu"), pr);
    await expect
      .poll(async () => {
        const [m, r] = await Promise.all([box(page.getByTestId("ti-pr-menu")), box(pr)]);
        return Math.abs(m.y - (r.y + r.height) - 4 * (zoom / 100)) < 1.5;
      })
      .toBe(true);
    await page.keyboard.press("Escape");
  });
}

// The Run in items, the other project's action and its run, the pull requests, the Changes
// fold and Fix's one send: ThreadInfoCard.test.tsx ("nine projects in a workspace").
test("nine projects in a workspace: the project menu spans the card less 6px a side", async ({ page }) => {
  await openWithCard(page, "ws9");
  const c = card(page);
  await c.getByTestId("ti-project").click();
  const menu = page.getByTestId("ti-project-menu");
  await expect(menu.getByTestId("ti-runin-item")).toHaveCount(9);
  // The row's own width, once its open animation ends.
  await expect
    .poll(async () => {
      const [m, k] = await Promise.all([menu.boundingBox(), c.boundingBox()]);
      return Math.round((k?.width ?? 0) - (m?.width ?? 0));
    })
    .toBe(14);
  await page.keyboard.press("Escape");
});

// A working thread's Push (disabled, its reason, no git.push) and a child's parent row:
// ThreadInfoCard.test.tsx ("a working thread", "a child thread").

const overlay = (page: Page) => page.getByTestId("thread-info-overlay");

test("a narrow pane: the card steps aside, the toggle floats it over the conversation, and the inline card returns with room", async ({ page }) => {
  await openWithCard(page, "single");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  // Not shown by itself: the toggle reads off, though the inline card's preference stays on.
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expectTooltip(page, toggle(page), "Toggle Thread Info");
  // The conversation keeps its width: the whole thread body.
  const body = await page.getByTestId("thread-pane-body").boundingBox();
  expect(body?.width ?? 0).toBeLessThan(800);

  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toHaveAttribute("aria-label", "Thread info");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).getByTestId("ti-project")).toContainText("code-foundry");
  // Over the conversation, which does not reflow: the body is as wide, the box 12px in from its top right.
  const after = await page.getByTestId("thread-pane-body").boundingBox();
  expect(after?.width).toBe(body?.width);
  const box = await overlay(page).boundingBox();
  expect(Math.round((after?.x ?? 0) + (after?.width ?? 0) - (box?.x ?? 0) - (box?.width ?? 0))).toBe(12);
  expect(Math.round((box?.y ?? 0) - (after?.y ?? 0))).toBe(12);
  expect(box?.width).toBe(308);

  // A menu inside works over it, and its Escape closes the menu only.
  await card(page).getByTestId("ti-project").click();
  await expect(page.getByTestId("ti-add-project")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ti-add-project")).toHaveCount(0);
  await expect(overlay(page)).toBeVisible();
  // A press inside keeps it (a fold), a second toggle hides it.
  await card(page).getByTestId("ti-usage").click();
  await expect(card(page).getByTestId("ti-usage-detail")).toBeVisible();
  await toggle(page).click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  // With room the inline card takes its place: hiding never cleared the preference.
  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("thread-info")).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  // Narrow again: it does not come back by itself.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(overlay(page)).toHaveCount(0);
});

test("the overlay: off at narrow turns the card on, Escape and a press outside hide it, the chord focuses it", async ({ page }) => {
  const { id } = (await mockPost("thread-info?scenario=single")) as { id: string };
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  // The chord shows it focused; Escape hides it and gives focus to the toggle.
  await page.getByTestId("thread-pane").focus();
  await page.keyboard.press("Meta+Shift+i");
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  // Hidden, not off: with room the inline card shows.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("thread-info")).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });

  // A tooltip open elsewhere (a sidebar row's hover card, open at once under the pointer)
  // does not take Escape from the focused overlay.
  await page.getByTestId("thread-pane").focus();
  await page.keyboard.press("Meta+Shift+i");
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toBeFocused();
  await row(page, "s:s-1").hover();
  await expect(page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])')).toHaveAttribute("data-thread-id", "s-1");
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();

  // A click does not move focus; a press outside (the conversation) hides it.
  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).not.toBeFocused();
  await page.getByTestId("thread-pane-body").click({ position: { x: 40, y: 200 } });
  await expect(overlay(page)).toHaveCount(0);

  // Escape in the composer's prompt is the prompt's (focused without a press, which is outside).
  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await page.locator("[data-chord-yield] [contenteditable]").first().focus();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeVisible();

  // Another thread hides it.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await expect(overlay(page)).toHaveCount(0);
  await row(page, `s:${id}`).click();
  await expect(overlay(page)).toHaveCount(0);
});

// No git group, the server rows and their stop squares, an expired cache, a thread under a
// cent: ThreadInfoCard.test.tsx ("a folder without git", "servers", "an expired cache",
// "a thread under a cent").

/** A long conversation (the mock's html-scroll, s-r1) with the card shown over its right. */
async function openLongWithCard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=html-scroll");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-r1");
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("thread-html-frame")).toHaveAttribute("data-shown", "true");
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
}

async function wheelAt(page: Page, x: number, y: number, dy: number, times = 3): Promise<void> {
  await page.mouse.move(x, y);
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(50);
  }
}

async function box(l: ReturnType<Page["getByTestId"]>): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return b;
}

test("the card lays over the conversation: the list and composer keep clear, the scrollbar stays at the edge, a wheel under the card scrolls the list", async ({ page }) => {
  await openLongWithCard(page);
  const timeline = page.getByTestId("thread-timeline");
  const body = await box(page.getByTestId("thread-pane-body"));
  const c = await box(card(page));
  // The list's scroller spans the body, its thin scrollbar in the card's 12px gutter; the rows and the composer end left of the card.
  const t = await box(timeline);
  expect(Math.abs(t.x + t.width - (body.x + body.width))).toBeLessThan(1);
  expect(await timeline.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(12);
  expect(Math.abs(c.x + c.width + 12 - (body.x + body.width))).toBeLessThan(1);
  const log = await box(timeline.getByRole("log"));
  expect(log.x + log.width).toBeLessThanOrEqual(c.x);
  const composer = await box(page.getByTestId("composer-input"));
  expect(composer.x + composer.width).toBeLessThanOrEqual(c.x);
  // The dock (the composer's column) ends 12px left of the card.
  const dock = await box(page.locator('[data-testid="thread-pane-body"] .dock'));
  expect(Math.abs(dock.x + dock.width + 12 - c.x)).toBeLessThan(1);
  // The card is shorter than the pane: a wheel under it reaches the list.
  expect(c.y + c.height + 100).toBeLessThan(body.y + body.height);
  const top = () => timeline.evaluate((el) => el.scrollTop);
  const before = await top();
  await wheelAt(page, c.x + c.width / 2, c.y + c.height + 60, -150);
  await expect.poll(top).toBeLessThan(before - 200);
  await expect(page.getByTestId("thread-jump-bottom")).toHaveAttribute("data-shown", "true");
});

test("a conversation too short to scroll: no scrollbar, and the card keeps 12px from the pane's edge and from the dock, as when it scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openWithCard(page, "single");
  const timeline = page.getByTestId("thread-timeline");
  // Nothing to scroll: WebKit gives a custom scrollbar no room then, whatever scrollbar-gutter says.
  expect(await timeline.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(await timeline.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(0);
  const gaps = async () => {
    const [body, c, dock] = await Promise.all([box(page.getByTestId("thread-pane-body")), box(card(page)), box(page.locator('[data-testid="thread-pane-body"] .dock'))]);
    return { edge: Math.round(body.x + body.width - (c.x + c.width)), dock: Math.round(c.x - (dock.x + dock.width)) };
  };
  expect(await gaps()).toEqual({ edge: 12, dock: 12 });
  // The list grows taller than the pane (a shorter window): the scrollbar appears and the card does not move.
  const before = await box(card(page));
  await page.setViewportSize({ width: 1300, height: 420 });
  await expect.poll(() => timeline.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(12);
  expect(await gaps()).toEqual({ edge: 12, dock: 12 });
  expect((await box(card(page))).x).toBe(before.x);
});

test("a wheel over a card shorter than the pane scrolls the conversation, which stays up", async ({ page }) => {
  await openLongWithCard(page);
  const timeline = page.getByTestId("thread-timeline");
  const c = await box(card(page));
  const top = () => timeline.evaluate((el) => el.scrollTop);
  const before = await top();
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, -150);
  await expect.poll(top).toBeLessThan(before - 200);
  // The reader's own scroll: the list unpins (no snap back, after a resize hold's 400 ms too).
  await page.waitForTimeout(700);
  expect(await top()).toBeLessThan(before - 200);
  await expect(timeline).not.toHaveAttribute("data-at-bottom");
  const jump = page.getByTestId("thread-jump-bottom");
  await expect(jump).toHaveAttribute("data-shown", "true");
  expect(await page.getByTestId("thread-info").evaluate((el) => el.scrollTop)).toBe(0);
  // The chip centres on the conversation, left of the card.
  const j = await box(jump);
  expect(j.x + j.width).toBeLessThan(c.x);
  // Down over the card goes back to the bottom.
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, 400, 4);
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
});

test("a card taller than the pane scrolls itself under the wheel", async ({ page }) => {
  await openWithCard(page, "ws9");
  await page.setViewportSize({ width: 1300, height: 600 });
  const aside = page.getByTestId("thread-info");
  await expect.poll(() => aside.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const timeline = page.getByTestId("thread-timeline");
  const tlTop = await timeline.evaluate((el) => el.scrollTop);
  const a = await box(aside);
  await wheelAt(page, a.x + a.width / 2, a.y + a.height / 2, 100);
  await expect.poll(() => aside.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  expect(await timeline.evaluate((el) => el.scrollTop)).toBe(tlTop);
});

/** A long conversation of forty turns (the mock's long state, s-r1), most rows unmounted, with the card shown over its right, at the bottom. */
async function openVeryLongWithCard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=long");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-r1");
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
}

/** Whether a mounted row of the list is under the list's top and bottom edges (a few px in), probed with elementsFromPoint in the rows' column (the composer floats over the bottom one). */
async function edgesCovered(page: Page): Promise<{ top: boolean; bottom: boolean; scrollTop: number }> {
  return page.getByTestId("thread-timeline").evaluate(async (el) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = el.getBoundingClientRect();
    const log = el.querySelector('[role="log"]')?.getBoundingClientRect();
    const x = log ? log.left + log.width / 2 : box.left + box.width / 3;
    const rowAt = (y: number) => document.elementsFromPoint(x, y).some((e) => el.contains(e) && e.closest("[data-index]") !== null);
    return { top: rowAt(box.top + 2), bottom: rowAt(box.bottom - 2), scrollTop: el.scrollTop };
  });
}

test("a wheel over the card leaves no gap: the rows under the list's top and bottom edges are mounted, scrolling up and down", async ({ page }) => {
  await openVeryLongWithCard(page);
  const timeline = page.getByTestId("thread-timeline");
  const c = await box(card(page));
  const t = await box(timeline);
  expect(c.y + c.height + 100).toBeLessThan(t.y + t.height);
  const total = await timeline.evaluate((el) => el.scrollHeight);
  // Far more than the pane, and most rows unmounted: the virtualizer has to mount what the wheel brings in.
  expect(total).toBeGreaterThan(t.height * 5);
  const before = await timeline.evaluate((el) => el.scrollTop);
  // Toward older content, at a trackpad's pace.
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, -120, 12);
  const up = await edgesCovered(page);
  expect(up.scrollTop).toBeLessThan(before - 1000);
  expect(up).toMatchObject({ top: true, bottom: true });
  await expect(page.getByTestId("thread-jump-bottom")).toHaveAttribute("data-shown", "true");
  // Further up, then toward newer content, short of the bottom.
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, -120, 12);
  const higher = await timeline.evaluate((el) => el.scrollTop);
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, 120, 8);
  const down = await edgesCovered(page);
  expect(down.scrollTop).toBeGreaterThan(higher + 500);
  expect(down.scrollTop).toBeLessThan(before - 300);
  expect(down).toMatchObject({ top: true, bottom: true });
  await expect(timeline).not.toHaveAttribute("data-at-bottom");
});

test("a wheel over a menu of the card leaves the conversation where it is", async ({ page }) => {
  await openVeryLongWithCard(page);
  const timeline = page.getByTestId("thread-timeline");
  const before = await timeline.evaluate((el) => el.scrollTop);
  await card(page).getByTestId("ti-project").click();
  const menu = page.getByTestId("ti-project-menu");
  await expect(menu).toBeVisible();
  const m = await box(menu);
  await wheelAt(page, m.x + m.width / 2, m.y + m.height / 2, -150);
  await page.waitForTimeout(300);
  expect(await timeline.evaluate((el) => el.scrollTop)).toBe(before);
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("a page's Expand covers the conversation, not the card beside it", async ({ page }) => {
  await openLongWithCard(page);
  const c = await box(card(page));
  await page.getByTestId("thread-html-expand").last().click();
  const lightbox = page.getByTestId("thread-html-lightbox");
  await expect(lightbox).toBeVisible();
  const l = await box(lightbox);
  expect(l.x + l.width).toBeLessThanOrEqual(c.x);
  // The card stays usable while the page is open.
  await card(page).getByTestId("ti-context").hover();
  await expect(page.getByTestId("thread-html-lightbox")).toBeVisible();
  await page.getByTestId("thread-html-close").click();
  await expect(lightbox).toHaveCount(0);
});

// The MCP row's counts and colours, its menu's items, Reconnect, the openers and Open MCP
// panel: ThreadInfoCard.test.tsx ("the MCP row").
test("the MCP row: its value lines up with Usage's, its menu opens under the row", async ({ page }) => {
  // s-r1 carries the MCP sketch's six servers (mock/mcp.ts): two connected, linear needs a login, playwright failed.
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await toggle(page).click();
  const c = card(page);
  const mcp = c.getByTestId("ti-mcp");
  await expect(c.getByTestId("ti-mcp-meta")).toHaveText(/^1 needs login\s*1 failed$/);
  expect(Math.abs((await rightOf(c.getByTestId("ti-mcp-meta"))) - (await rightOf(c.getByTestId("ti-usage-meta"))))).toBeLessThan(1);
  await c.getByTestId("ti-mcp-needs-login").click();
  const menu = page.getByTestId("ti-mcp-menu");
  await expect(menu).toBeVisible();
  await expectUnderRow(menu, mcp);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

/** SHOTS=<dir>: a child thread's Lineage card with its place, and a run's without one, WebKit, 1280x800 at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`lineage card screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("the Lineage rows' hover card", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await mockPost("workspace?name=Platform&projects=repo-cf,repo-gp,repo-dot");
      const { id } = (await mockPost("thread-info?scenario=single")) as { id: string };
      const child = (await mockPost(`multi-thread?projects=repo-cf,repo-gp,repo-dot&project=repo-cf&branch=cf/agents-panel&name=Agents%20panel&workspace=Platform&createdBy=${id}`)) as { id: string };
      await mockPost(`thread/status?id=${child.id}&status=busy`);
      await openApp(page);
      await row(page, `s:${id}`).click();
      await toggle(page).click();
      await expect(card(page)).toBeVisible();
      const rows = page.getByTestId("ti-lineage-row");
      await rows.locator(`xpath=self::*[@data-id="${child.id}"]`).hover();
      await expect(page.getByTestId("ti-lineage-place")).toBeVisible();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(shots)}/lineage-card-child-${scheme}.png` });
      await page.mouse.move(640, 700);
      await expect(page.getByTestId("ti-lineage-place")).toHaveCount(0);
      await rows.and(page.locator('[data-kind="agent"]')).first().hover();
      await expect(page.getByTestId("ti-lineage-model")).toBeVisible();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(shots)}/lineage-card-run-${scheme}.png` });
    });
  });
}

/** SHOTS=<dir>: an archived thread's card after its worktree went, and a pull request opened from it, WebKit, 1280x800 at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`archived thread card screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("the pull requests of a thread whose worktree was cleaned up", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const { id } = (await mockPost("thread-info?scenario=archived")) as { id: string };
      await openApp(page);
      await page.getByTestId("archived-header").click();
      await row(page, `s:${id}`).click();
      await toggle(page).click();
      const prs = card(page).getByTestId("ti-pr");
      await expect(prs).toHaveCount(2);
      await expect(card(page).getByTestId("ti-branch")).toHaveCount(0);
      await page.mouse.move(640, 700);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(shots)}/archived-card-${scheme}.png` });
      await prs.first().click();
      await expect(page.getByTestId("pr-inner-bar")).toBeVisible();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${String(shots)}/archived-card-pr-${scheme}.png` });
    });
  });
}
