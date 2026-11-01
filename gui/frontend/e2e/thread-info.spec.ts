import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, mockUrl, openApp, openTooltip, resetMock, row } from "./fixtures";

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
});

test("one project: place, branch, pull requests, changes, shells, lineage, MCP, context and usage", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  // Off by default; the toggle (view.thread-info) shows it beside the conversation and composer.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  const id = await openWithCard(page, "single");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  const c = card(page);
  await expect(c.getByTestId("ti-workspace")).toHaveCount(0);
  await expect(c.getByTestId("ti-project")).toContainText("code-foundry");
  await expect(c.getByTestId("ti-project-meta")).toHaveText("Fresh copy");
  // One project: the menu offers Add project only (no Run in, nothing to save).
  await c.getByTestId("ti-project").click();
  await expect(page.getByTestId("ti-add-project")).toBeVisible();
  await expect(page.getByTestId("ti-runin-item")).toHaveCount(0);
  await expect(page.getByTestId("ti-save-workspace")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(c.getByTestId("ti-open-in")).toHaveText(/Open in Finder/);
  await expect(c.getByTestId("ti-action")).toContainText("Dev");
  await expect(c.getByTestId("ti-action-project")).toHaveCount(0);

  await expect(c.getByTestId("ti-branch")).toHaveAttribute("data-branch", "cf/sidebar-tree");
  await expect(c.getByTestId("ti-branch-ahead")).toHaveText("3");
  const prs = c.getByTestId("ti-pr");
  await expect(prs).toHaveCount(2);
  await expect(prs.nth(0)).toHaveAttribute("data-number", "78");
  await expect(prs.nth(0).getByTestId("ti-pr-line")).toHaveText(/#78\s*review requested/);
  await expect(prs.nth(1)).toHaveAttribute("data-state", "merged");
  await expect(c.getByTestId("ti-pr-project")).toHaveCount(0);
  await expect(c.getByTestId("ti-changes-meta")).toHaveText(/\+42\s*−9\s*· 4 files/);

  // The thread's own background shell, folded.
  await expect(c.getByTestId("ti-shells")).toContainText("1 shell");
  await c.getByTestId("ti-shells").click();
  await expect(c.getByTestId("ti-shell")).toHaveCount(1);

  // Lineage: running subagents and the child threads that work or wait, then the finished ones.
  await expect(c.getByTestId("ti-lineage-label")).toContainText(/Lineage · \d+ running/);
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k1"]')).toHaveAttribute("data-state", "working");
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k2"]')).toHaveAttribute("data-state", "attention");
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k3"]')).toHaveCount(0);
  // Subagent runs have no stop square; a live child's interrupts it, by click or by Enter, without opening it.
  await expect(c.locator('[data-testid="ti-lineage-stop"]')).toHaveCount(2);
  await expect(c.locator('[data-testid="ti-lineage-row"][data-kind="agent"]').first()).toBeVisible();
  const k1 = c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k1"]');
  await k1.hover();
  await c.locator('[data-testid="ti-lineage-stop"][data-id="s-ti-k1"]').click();
  await c.locator('[data-testid="ti-lineage-stop"][data-id="s-ti-k2"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.interrupt").map((i) => i.args.id)).toEqual(["s-ti-k1", "s-ti-k2"]);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await c.getByTestId("ti-previous").click();
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k3"]')).toHaveAttribute("data-state", "done");

  await expect(c.getByTestId("ti-mcp").locator("> span").nth(1)).toHaveText("2 connected");
  // Context: "Context cached for 41m" on the left, the bar filling the middle, the window's tokens on the right.
  await expect(c.getByTestId("ti-context-label")).toHaveText("Context cached for 41m");
  await expect(c.getByTestId("ti-context-cache")).toHaveText("cached for 41m");
  await expect(c.getByTestId("ti-context-bar")).toBeVisible();
  await expect(c.getByTestId("ti-context-meta")).toHaveText("221K of 1M");
  await expectTooltip(page, c.getByTestId("ti-context"), /^22% of context window used\s*Cache expires in 41 min\s*\$2\.21 to re-read it after that$/);

  // Usage: the row's value is the total cost in cents (no token count); the hover card splits it by model, one line each.
  const usage = c.getByTestId("ti-usage");
  await expect(usage.locator("> span").nth(0)).toHaveText("Usage");
  const cost = c.getByTestId("ti-usage-meta");
  await expect(cost).toHaveText(/^\$[\d,]+\.\d\d$/);
  await page.mouse.move(0, 0);
  await usage.hover();
  const tip = openTooltip(page);
  await expect(tip).toContainText("By model");
  await expect(tip.getByTestId("ti-usage-model-share")).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(tip.getByTestId("ti-usage-model-cost").nth(i)).toHaveText(/^\$[\d,]+\.\d\d$/);
    await expect(tip.getByTestId("ti-usage-model-share").nth(i)).toHaveText(/^\d+\.\d%$/);
    // The share sits on its cost's line, never wrapped under it.
    const [a, b] = await Promise.all([tip.getByTestId("ti-usage-model-cost").nth(i).boundingBox(), tip.getByTestId("ti-usage-model-share").nth(i).boundingBox()]);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? -100))).toBeLessThan(1);
  }
  await expect(tip).not.toContainText(/saved/i);
  await page.mouse.move(0, 0);

  // The fold: the token kinds, their total (the row's cost), what cache reads saved, the requests.
  await expect(c.getByTestId("ti-usage-detail")).toHaveCount(0);
  await usage.click();
  await expect(usage).toHaveAttribute("aria-expanded", "true");
  await expect(c.getByTestId("ti-usage-chevron")).toHaveAttribute("data-open", "");
  await expect(c.getByTestId("ti-usage-kind")).toHaveCount(4);
  await expect(c.getByTestId("ti-usage-kind")).toHaveText([/^Input.*\$/, /^Output.*\$/, /^Cache read.*\$/, /^Cache write.*\$/]);
  const total = c.getByTestId("ti-usage-total");
  await expect(total.locator("span")).toHaveText(["Total", /^[\d.]+[KMB]$/, (await cost.textContent()) ?? ""]);
  await expect(c.getByTestId("ti-usage-saved")).toHaveText(/^Saved by cache reads\$[\d,]+\.\d\d$/);
  await expect(c.getByTestId("ti-usage-saved").locator("span").last()).toHaveClass(/text-cf-success-text/);
  await expect(c.getByTestId("ti-usage-detail")).toContainText("Requests");
  // An open fold is not selected: with the pointer elsewhere it has a closed row's background, only its chevron says open.
  await page.mouse.move(0, 0);
  const bg = (l: typeof usage) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(async () => bg(usage)).toBe(await bg(c.getByTestId("ti-context")));

  // Changes opens the cwd's Changes tab (its files and commits); a pull request its PR tab.
  await c.getByTestId("ti-changes").click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(page.getByTestId("changes-surface").getByTestId("file-name")).toHaveText(["tree.ts", "Sidebar.tsx", "tree.test.ts", "sidebar-tree.md"]);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/^Changes$/);
  // At 1280px the side panel leaves the conversation too little room: the card steps aside until it closes.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await page.getByTestId("panel-toggle").click();
  await expect(card(page)).toBeVisible();
  await prs.nth(0).click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
  await page.getByTestId("panel-toggle").click();
  await expect(card(page)).toBeVisible();

  // The branch row copies the branch.
  await c.getByTestId("ti-branch").click();
  await expect(page.getByText("Branch copied")).toBeVisible();

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
  await expect(c.getByTestId("ti-lineage-menu-trigger")).toHaveAttribute("aria-label", "Lineage options");

  // One right edge, the row's padding inside its own: values without a chevron, every ellipsis, every chevron.
  const edge = (await rightOf(c.getByTestId("ti-context"))) - 4;
  const ends = [
    "ti-context-meta",
    "ti-branch-meta",
    "ti-lineage-menu-trigger",
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
  // remount it, flash and drop its focus). The run's terminal tab takes the keyboard.
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
    await expect(page.getByTestId("bottom-panel").locator('[data-kind="action"]')).toHaveCount(n);
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
  await expect(page.locator('[data-testid="panel-body"][data-surface="pullrequest"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Lineage's ellipsis is the same button with the same menu placement and the same
  // menu-open rule: only its block lit. Its label has no click: hovering it lights nothing.
  const label = c.getByTestId("ti-lineage-label");
  const labelMore = c.getByTestId("ti-lineage-menu-trigger");
  await label.hover({ position: { x: 30, y: 10 } });
  await expect.poll(() => lit(label, labelMore)).toEqual([blocks.none, blocks.none, blocks.none]);
  // Hovering its ellipsis lights that block alone: no dim block over a label that is not a target.
  await labelMore.hover();
  await expect.poll(() => lit(label, labelMore)).toEqual([blocks.none, blocks.full, blocks.none]);
  await labelMore.click();
  const lineageMenu = page.getByTestId("ti-lineage-menu");
  await expect(lineageMenu.getByTestId("ti-archive-finished")).toBeVisible();
  await expectUnderRow(lineageMenu, label);
  await page.mouse.move(0, 0);
  await expect.poll(() => lit(label, labelMore)).toEqual([blocks.none, blocks.full, blocks.none]);
  await page.keyboard.press("Escape");
});

test("the action menu: a gear on the highlighted item opens its editor, the item hovers as two blocks", async ({ page }) => {
  await openWithCard(page, "single");
  const c = card(page);
  await c.getByTestId("ti-action-more").click();
  const menu = page.getByTestId("ti-action-menu");
  await expect(menu).toBeVisible();
  const items = menu.getByTestId("ti-action-item");
  await expect(items).toHaveCount(6);
  const item = (name: string) => items.filter({ hasText: name });
  const gear = (name: string) => item(name).getByTestId("ti-action-gear");
  const opacities = () => items.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector("[data-action-gear]") ?? el).opacity));
  // A gear in every item (nothing moves), Add action without one.
  await expect(menu.getByTestId("ti-action-gear")).toHaveCount(6);
  await expect(menu.getByTestId("ti-add-action").getByTestId("ti-action-gear")).toHaveCount(0);
  await expect(gear("Test")).toHaveAttribute("aria-label", "Edit action");

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

  // A gear click opens the editor for that action and runs nothing.
  const runs = async () => (await invocations()).filter((i) => i.name === "action.run").length;
  await gear("Test").hover();
  await gear("Test").click();
  await expect(menu).toHaveCount(0);
  const dialog = page.getByTestId("action-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-mode", "edit");
  await expect(dialog.getByTestId("action-name")).toHaveValue("Test");
  await page.waitForTimeout(300);
  expect(await runs()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Enter on a focused gear: the same, for its action.
  await c.getByTestId("ti-action-more").click();
  await expect(menu).toBeVisible();
  await item("Build").hover({ position: { x: 30, y: 10 } });
  await page.keyboard.press("ArrowRight");
  await expect(gear("Build")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("action-name")).toHaveValue("Build");
  expect(await runs()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The item's text still runs it.
  await c.getByTestId("ti-action-more").click();
  await item("Check").click({ position: { x: 30, y: 10 } });
  await expect(menu).toHaveCount(0);
  await expect.poll(runs).toBe(1);
  await expect(dialog).toHaveCount(0);
});

/** Sets the page zoom (stores/ui setZoom), as zoom-popovers.spec.ts does. */
async function setZoom(page: Page, percent: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setZoom(${String(percent)}))`);
  await expect(page.locator("html")).toHaveAttribute("data-zoom", String(percent));
}

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

test("nine projects in a workspace: Run in menu, other projects' pull requests, Changes fold, Fix sends a prompt", async ({ page }) => {
  const id = await openWithCard(page, "ws9");
  const c = card(page);
  await expect(c.getByTestId("ti-workspace")).toContainText("platform");
  await expect(c.getByTestId("ti-workspace-meta")).toHaveText("9 projects");
  await expect(c.getByTestId("ti-project")).toContainText("api");
  await expect(c.getByTestId("ti-project-chevron")).not.toHaveAttribute("data-open", "");

  await c.getByTestId("ti-project").click();
  const menu = page.getByTestId("ti-project-menu");
  await expect(menu).toBeVisible();
  await expect(c.getByTestId("ti-project-chevron")).toHaveAttribute("data-open", "");
  await expect(menu.getByTestId("ti-add-project")).not.toHaveAttribute("data-disabled", "");
  // A named workspace: nothing to save.
  await expect(menu.getByTestId("ti-save-workspace")).toHaveCount(0);
  await expect(menu.getByTestId("ti-runin-item")).toHaveCount(9);
  await expect(menu.locator('[data-testid="ti-runin-item"][data-current]')).toHaveAttribute("data-project", "repo-api");
  await expect(menu.locator('[data-testid="ti-runin-item"][data-project="repo-auth-lib"]')).toHaveText("auth-lib @ cf/auth-tokens-2");
  await expect(menu.locator('[data-testid="ti-runin-item"][data-project="repo-web"]')).toHaveText("web");
  // The menu spans the card less 6px a side (the row's own width), once its open animation ends.
  await expect
    .poll(async () => {
      const [m, k] = await Promise.all([menu.boundingBox(), c.boundingBox()]);
      return Math.round((k?.width ?? 0) - (m?.width ?? 0));
    })
    .toBe(14);
  await page.keyboard.press("Escape");

  // The action last run in this thread was web's: named with its project.
  await expect(c.getByTestId("ti-action")).toContainText("Typecheck");
  await expect(c.getByTestId("ti-action-project")).toHaveText("web");
  // It runs for the thread (its cwd is api) in its web checkout: the thread's bottom panel, no toast.
  await c.getByTestId("ti-action").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "action.run").map((i) => i.context?.activeThreadId)).toEqual([id]);
  await expect(page.getByTestId("bottom-panel").locator('[data-kind="action"]')).toHaveCount(1);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Typecheck" })).toHaveCount(0);

  // Pull requests over four projects: the cwd's first and unnamed, the others with their project; a stacked one names its base.
  const prs = c.getByTestId("ti-pr");
  await expect(prs).toHaveCount(7);
  await expect(prs.nth(0)).toHaveAttribute("data-number", "412");
  await expect(prs.nth(0).getByTestId("ti-pr-project")).toHaveCount(0);
  await expect(c.locator('[data-testid="ti-pr"][data-number="58"]').getByTestId("ti-pr-stacked")).toHaveText("#57");
  await expect(c.locator('[data-testid="ti-pr"][data-number="58"]').getByTestId("ti-pr-project")).toHaveText("auth-lib");
  await expect(c.locator('[data-testid="ti-pr"][data-number="19"]')).toHaveAttribute("data-state", "draft");

  await expect(c.getByTestId("ti-changes-meta")).toHaveText(/· 4 projects/);
  await c.getByTestId("ti-changes").click();
  await expect(c.getByTestId("ti-changes-project")).toHaveCount(4);
  // A project's row opens that checkout's Changes tab, named for the project.
  await c.locator('[data-testid="ti-changes-project"][data-project="repo-web"]').click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-project", "repo-web");
  await expect(page.getByTestId("changes-surface").getByTestId("file-name")).toHaveText(["auth.ts", "auth.test.ts"]);
  await page.getByTestId("panel-toggle").click();

  // Diverged: Fix sends the thread its prompt, the composer's draft untouched.
  await expect(c.getByTestId("ti-git")).toHaveAttribute("data-kind", "diverged");
  // A double click sends once (the button waits for the send).
  await c.getByTestId("ti-git-fix").dblclick();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.send").map((i) => [i.args.id, i.args.text])).toEqual([
    [id, expect.stringContaining("diverged from its upstream (3 ahead, 1 behind)") as unknown as string],
  ]);
});

test("a working thread: Push waits for the model, with the reason on hover", async ({ page }) => {
  await openWithCard(page, "busy");
  const push = card(page).getByTestId("ti-git");
  await expect(push).toHaveAttribute("data-kind", "push");
  await expect(push).toHaveAttribute("data-disabled", "");
  await expectTooltip(page, push, "A model is still working on this branch.");
  await push.click();
  await page.waitForTimeout(300);
  expect((await invocations()).filter((i) => i.name === "git.push")).toEqual([]);
});

test("a child thread: its parent row leads the lineage and goes to the parent", async ({ page }) => {
  // A child has no sidebar row: open it from its parent's card (the card stays open).
  await mockPost("thread-info?scenario=child");
  await openWithCard(page, "single");
  await card(page).locator('[data-testid="ti-lineage-row"][data-id="s-ti-child"]').click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ti-child");
  const parent = card(page).getByTestId("ti-parent");
  await expect(parent).toContainText("Fix the stale PR badge");
  await expect(parent).toHaveAttribute("data-id", "s-ti-1");
  await expect(parent.getByTestId("ti-parent-meta")).toHaveText("Done");
  await parent.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ti-1");
});

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

test("a folder without git: no git group", async ({ page }) => {
  await openWithCard(page, "nogit");
  const c = card(page);
  await expect(c.getByTestId("ti-project")).toContainText("writing");
  await expect(c.getByTestId("ti-project-meta")).toHaveText("Project folder");
  await expect(c.getByTestId("ti-git-group")).toHaveCount(0);
  await expect(c.getByTestId("ti-context")).toBeVisible();
});

test("servers: a listening shell is a row that opens its port and stops the shell", async ({ page }) => {
  const id = await openWithCard(page, "servers");
  const c = card(page);
  const servers = c.getByTestId("ti-server");
  await expect(servers).toHaveCount(2);
  const web = servers.nth(0);
  const docs = servers.nth(1);
  await expect(web).toHaveAttribute("data-port", "5173");
  await expect(web).toContainText("localhost:5173");
  await expect(web.getByTestId("ti-server-line")).toHaveText(/^pnpm --dir web dev\s*· node\s*· 1m \d\ds$/);
  // Several ports: the first on the row, the rest in the hover card.
  await expect(web.getByTestId("ti-server-meta")).toHaveText("+1");
  await expectTooltip(page, web, /localhost:5173\s*localhost:24678/);
  await expect(docs.getByTestId("ti-server-line")).toContainText("· python");
  await expect(docs.getByTestId("ti-server-meta")).toHaveCount(0);
  // The shells that listen on nothing stay folded below.
  await expect(c.getByTestId("ti-shells")).toContainText("2 more shells");

  // A click opens the port in the browser.
  await docs.click();
  const opened = async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url);
  await expect.poll(opened).toEqual(["http://localhost:9399"]);

  // The stop square stops the shell, by click or by Enter, without opening the port; a
  // double click stops once.
  const stops = async () => (await invocations()).filter((i) => i.name === "thread.shell.stop").map((i) => `${i.args.id ?? ""} ${i.args.task ?? ""}`);
  await docs.hover();
  await c.locator('[data-testid="ti-server-stop"][data-task="bd9r3t6w1"]').dblclick();
  await expect.poll(stops).toEqual([`${id} bd9r3t6w1`]);
  await expect(servers).toHaveCount(1);
  await expect(page.getByTestId("thread-pane").getByText("Stopped background shell: python3 -m http.server 9399 --directory docs/_build")).toBeVisible();
  await c.locator('[data-testid="ti-server-stop"][data-task="bk4v8n2p7"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(stops).toEqual([`${id} bd9r3t6w1`, `${id} bk4v8n2p7`]);
  await expect(servers).toHaveCount(0);
  await expect(c.getByTestId("ti-shells")).toContainText("2 shells");
  expect(await opened()).toEqual(["http://localhost:9399"]);
});

test("an expired cache: the context row and its hover card say nothing of it", async ({ page }) => {
  const id = await openWithCard(page, "single");
  const c = card(page);
  await expect(c.getByTestId("ti-context-cache")).toHaveText("cached for 41m");
  await mockPost(`thread/cache?id=${id}&ago=3700`);
  await expect(c.getByTestId("ti-context-cache")).toHaveCount(0);
  await expect(c.getByTestId("ti-context-label")).toHaveText("Context");
  await expect(c.getByTestId("ti-context-meta")).toHaveText("221K of 1M");
  await expectTooltip(page, c.getByTestId("ti-context"), /^22% of context window used$/);
});

test("a thread under a cent: the row reads <$0.01, the kinds show no cost, nothing saved", async ({ page }) => {
  await mockPost("usage?thread=s-2&model=claude-haiku-5-5&requests=2&input=900&output=350&cacheRead=4000&cacheWrite5m=1200");
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await toggle(page).click();
  const c = card(page);
  await expect(c.getByTestId("ti-usage-meta")).toHaveText("<$0.01");
  await expectTooltip(page, c.getByTestId("ti-usage"), /^By model\s*Haiku 5\.5\s*<\$0\.01\s*100\.0%$/);
  await c.getByTestId("ti-usage").click();
  await expect(c.getByTestId("ti-usage-kind")).toHaveText(["Input900", "Output350", "Cache read4K", "Cache write1.2K"]);
  await expect(c.getByTestId("ti-usage-total")).toHaveText(/^Total6\.5K<\$0\.01$/);
  await expect(c.getByTestId("ti-usage-saved")).toHaveCount(0);
  await expect(c.getByTestId("ti-usage-detail")).toContainText(/Requests\s*2/);
});

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

test("the MCP row: connected count on the left, attention counts in the value column; the whole row opens the menu, Open MCP panel first", async ({ page }) => {
  // s-r1 carries the MCP sketch's six servers (mock/mcp.ts): two connected, linear needs a login, playwright failed.
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await toggle(page).click();
  const c = card(page);
  const mcp = c.getByTestId("ti-mcp");
  await expect(mcp.locator("> span").nth(1)).toHaveText("2 connected");
  await expect(mcp.locator("> span").nth(1).locator("span")).toHaveClass(/text-cf-text-muted/);
  await expect(c.getByTestId("ti-mcp-meta")).toHaveText(/^1 needs login\s*1 failed$/);
  await expect(c.getByTestId("ti-mcp-needs-login")).toHaveClass(/text-cf-warning-text/);
  await expect(c.getByTestId("ti-mcp-failed")).toHaveClass(/text-cf-error-text/);
  // The value lines up with the other chevron rows' values (Usage's).
  expect(Math.abs((await rightOf(c.getByTestId("ti-mcp-meta"))) - (await rightOf(c.getByTestId("ti-usage-meta"))))).toBeLessThan(1);
  // No zone of its own any more: the row is the trigger.
  await expect(c.getByTestId("ti-mcp-menu-zone")).toHaveCount(0);
  await expect(mcp).toHaveAttribute("aria-haspopup", "menu");

  // A press on the value opens the menu, not the tab, at the row's width.
  await c.getByTestId("ti-mcp-needs-login").click();
  const menu = page.getByTestId("ti-mcp-menu");
  await expect(menu).toBeVisible();
  await expectUnderRow(menu, mcp);
  await expect(c.getByTestId("ti-mcp-chevron")).toHaveAttribute("data-open", "");
  await expect(page.getByTestId("mcp-surface")).toHaveCount(0);
  // Open MCP panel, Refresh, then Reconnect for the failed server only (a login cannot be done headlessly).
  await expect(menu.getByRole("menuitem")).toHaveText(["Open MCP panel", "Refresh", "Reconnect playwright"]);
  await expect(menu.getByTestId("ti-mcp-reconnect")).toHaveCount(1);
  await expect(menu.getByTestId("ti-mcp-reconnect")).toHaveText("Reconnect playwright");
  await menu.getByTestId("ti-mcp-reconnect").click();
  await expect(menu).toHaveCount(0);
  await expect
    .poll(async () => ((await (await fetch(`${mockUrl}/__mock/thread/calls`)).json()) as string[]).includes("mcp-reconnect s-r1 playwright"))
    .toBe(true);
  await expect(c.getByTestId("ti-mcp-meta")).toHaveText("1 needs login");
  await expect(c.getByTestId("ti-mcp-failed")).toHaveCount(0);
  await expect(mcp.locator("> span").nth(1)).toHaveText("3 connected");

  // The text and the chevron open the menu too; Enter and ArrowDown from the focused row as well.
  for (const target of [mcp.locator("> span").nth(1), c.getByTestId("ti-mcp-chevron")]) {
    await target.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  for (const key of ["Enter", "ArrowDown"]) {
    await mcp.focus();
    await page.keyboard.press(key);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  await expect(page.getByTestId("mcp-surface")).toHaveCount(0);

  // Open MCP panel opens the MCP tab.
  await mcp.click();
  await menu.getByTestId("ti-mcp-open-panel").click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "mcp");
  await expect(menu).toHaveCount(0);
});
