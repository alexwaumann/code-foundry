// Side panel split, PR 2 (docs/notes/panel-split-2-gui.md): a split panel renders its two
// tab groups stacked or side by side, with a divider, per-group strips, "+" and pickers.
// Every test here fails without the feature: there is no view.panel.split, no
// panel-split / panel-group / panel-split-divider element, and only one strip.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, invocations, mockUrl, openApp, openThreadChanges, resetMock, row } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await resetMock();
  // Wide enough for a 760px panel beside the sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
});

const panel = (page: Page) => page.getByTestId("side-panel");
const split = (page: Page) => page.getByTestId("panel-split");
const group = (page: Page, g: 0 | 1) => panel(page).locator(`[data-panel-group="${String(g)}"]`);
const tabsOf = (page: Page, g: 0 | 1) => group(page, g).getByRole("tab");
const divider = (page: Page) => page.getByTestId("panel-split-divider");

/** data-region of the focused element ("panel", "content", ...). */
function region(page: Page) {
  return page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") ?? null);
}

/** The group holding the focused element, or null. */
function focusedGroupEl(page: Page) {
  return page.evaluate(() => document.activeElement?.closest("[data-panel-group]")?.getAttribute("data-panel-group") ?? null);
}

async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(width)}))`);
}

/** The current panel's stored entry, through the app's own store. */
function entry(page: Page): Promise<{ ratio?: number; focused?: number; groups: { tabs: { id: string }[]; activeTabId: string | null }[] }> {
  return page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.getPanel("current"))`);
}

/** The persisted panel store (localStorage), for the current panel key. */
function persisted(page: Page, key: string): Promise<{ ratio?: number } | null> {
  return page.evaluate((k) => {
    const raw = localStorage.getItem("code-foundry.panel");
    const s = raw ? (JSON.parse(raw) as { state: { byKey: Record<string, { ratio?: number }> } }) : null;
    return s?.state.byKey[k] ?? null;
  }, key);
}

function rect(l: Locator) {
  return l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
}

/** s-1's panel at `width` with its Changes tab and README.md's diff (README.md active). */
async function worktreeAndDiff(page: Page, width = 420): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await setPanelWidth(page, width);
  await openThreadChanges(page);
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
  await page.locator('[data-nav-key="f:README.md"]').click();
  await expect(panel(page).getByRole("tab")).toHaveText(["Changes", "README.md"]);
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
}

/** The expanded panel's derived width (stores/ui.ts expandedPanelWidth) for the window and sidebar now. */
function expandedWidth(page: Page): Promise<number> {
  return page.evaluate(`__cfModule("/src/stores/ui.ts").then((m) => { const s = m.useUiStore.getState(); return m.expandedPanelWidth(s.windowWidth, m.visibleSidebarWidth(s)); })`);
}

async function invokeSplit(): Promise<void> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "view.panel.split" }),
  });
  expect(res.ok).toBe(true);
}

/** The group whose header holds the panel's expand and toggle buttons. */
async function controlsGroup(page: Page): Promise<string | null> {
  await expect(panel(page).getByTestId("panel-controls")).toHaveCount(1);
  return panel(page)
    .getByTestId("panel-controls")
    .evaluate((el) => el.closest("[data-panel-group]")?.getAttribute("data-panel-group") ?? null);
}

test("view.panel.split from the palette splits a stacked panel; it goes side by side from 721px, expanded or not; the buttons stay top right", async ({ page }) => {
  await worktreeAndDiff(page);
  // Unsplit: one group, the buttons in its header.
  await expect(split(page)).not.toHaveAttribute("data-split");
  expect(await controlsGroup(page)).toBe("0");

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Split Side Panel");
  await page.getByTestId("palette").locator('[data-command="view.panel.split"]').click();
  await expect(page.getByTestId("palette")).toHaveCount(0);

  // 420px: stacked. The active tab (README.md) moved to the new second group, which has focus.
  await expect(split(page)).toHaveAttribute("data-split", "true");
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await expect(tabsOf(page, 0)).toHaveText(["Changes"]);
  await expect(tabsOf(page, 1)).toHaveText(["README.md"]);
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(group(page, 0)).not.toHaveAttribute("data-focused");
  await expect(group(page, 0).getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(group(page, 1).getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
  await expect.poll(() => region(page)).toBe("panel");
  // The palette ran the local presenter: no daemon call.
  expect((await invocations()).map((i) => i.name)).not.toContain("view.panel.split");
  let [g0, g1, d] = await Promise.all([rect(group(page, 0)), rect(group(page, 1)), rect(divider(page))]);
  expect(Math.abs(g0.left - g1.left)).toBeLessThan(1);
  expect(g1.top).toBeGreaterThanOrEqual(g0.bottom);
  expect(d.height).toBe(1);
  await expect(divider(page)).toHaveAttribute("aria-orientation", "horizontal");
  // The default ratio: an even split of the height.
  expect(Math.abs(g0.height - g1.height)).toBeLessThan(2);
  // Stacked: the buttons in the first (top) group's header.
  expect(await controlsGroup(page)).toBe("0");
  // The unfocused group's active tab is tinted lighter than the focused one's.
  await expect(group(page, 0).locator('[role="presentation"][data-tab-id^="changes"]')).toHaveClass(/bg-cf-control-hover\/40/);
  await expect(group(page, 1).locator('[role="presentation"][data-tab-id^="diff"]')).toHaveClass(/dark:bg-cf-control-hover\/50/);

  // Just under the threshold (two 360px groups and the divider): still stacked. At it: side by side.
  await setPanelWidth(page, 585);
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await setPanelWidth(page, 720);
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await setPanelWidth(page, 721);
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  expect((await rect(page.getByTestId("side-panel-wrapper"))).width).toBe(721);
  await setPanelWidth(page, 760);
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  [g0, g1, d] = await Promise.all([rect(group(page, 0)), rect(group(page, 1)), rect(divider(page))]);
  expect(Math.abs(g0.top - g1.top)).toBeLessThan(1);
  expect(g1.left).toBeGreaterThanOrEqual(g0.right);
  expect(d.width).toBe(1);
  expect(Math.abs(g0.width - g1.width)).toBeLessThan(2);
  await expect(divider(page)).toHaveAttribute("aria-orientation", "vertical");
  // Side by side: the buttons in the second (right) group's header, and both headers line up.
  expect(await controlsGroup(page)).toBe("1");
  const [h0, h1] = await Promise.all([rect(group(page, 0).getByTestId("panel-header")), rect(group(page, 1).getByTestId("panel-header"))]);
  expect(h0.top).toBe(h1.top);
  expect(h0.height).toBe(h1.height);
  const [toggle, p] = await Promise.all([rect(panel(page).getByTestId("panel-toggle")), rect(panel(page))]);
  expect(p.right - toggle.right).toBeLessThan(16);

  // Expanded, it follows the width it renders at, whatever the stored one: side by side
  // in a wide window, stacked in a narrow one.
  await setPanelWidth(page, 420);
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await panel(page).getByTestId("panel-expand").click();
  await expect(page.getByTestId("side-panel-wrapper")).toHaveAttribute("data-expanded", "true");
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  expect(await controlsGroup(page)).toBe("1");
  // The derived width (expandedPanelWidth) is the one the wrapper renders at.
  expect((await rect(page.getByTestId("side-panel-wrapper"))).width).toBe(await expandedWidth(page));
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  expect(await controlsGroup(page)).toBe("0");
  const narrow = await rect(page.getByTestId("side-panel-wrapper"));
  expect(narrow.width).toBe(await expandedWidth(page));
  expect(narrow.width).toBeLessThan(721);
  // Nothing clipped: both groups sit inside the panel, full width.
  const [n0, n1, np] = await Promise.all([rect(group(page, 0)), rect(group(page, 1)), rect(panel(page))]);
  for (const g of [n0, n1]) {
    expect(g.left).toBeGreaterThanOrEqual(np.left);
    expect(g.right).toBeLessThanOrEqual(np.right);
  }
  expect(n1.top).toBeGreaterThanOrEqual(n0.bottom);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  expect(await controlsGroup(page)).toBe("1");
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel(page).getByTestId("panel-expand").click();
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  expect(await controlsGroup(page)).toBe("0");
});

test("cmd+\\ joins and splits again; the CLI's view.panel.split does too", async ({ page }) => {
  await worktreeAndDiff(page);
  await panel(page).click({ position: { x: 200, y: 300 } });
  await page.keyboard.press("Meta+Backslash");
  await expect(split(page)).toHaveAttribute("data-split", "true");
  await expect(tabsOf(page, 1)).toHaveText(["README.md"]);

  // Joining: one strip, the second group's tabs after the first's, its active tab kept.
  await page.keyboard.press("Meta+Backslash");
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(divider(page)).toHaveCount(0);
  await expect(group(page, 1)).toHaveCount(0);
  await expect(panel(page).getByRole("tab")).toHaveText(["Changes", "README.md"]);
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
  expect(await controlsGroup(page)).toBe("0");
  // Focus stayed in the panel, so the keys still work.
  await expect.poll(() => region(page)).toBe("panel");

  // The CLI: CommandService.Invoke emits ShowView "panel.split" to every window.
  await invokeSplit();
  await expect(split(page)).toHaveAttribute("data-split", "true");
  await invokeSplit();
  await expect(split(page)).not.toHaveAttribute("data-split");
  expect((await invocations()).map((i) => i.name).filter((n) => n === "view.panel.split")).toHaveLength(2);
});

test("the orientation flips when the panel's resize drag ends, not during it", async ({ page }) => {
  await worktreeAndDiff(page, 620);
  await page.keyboard.press("Meta+Backslash");
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");

  const h = await page.getByTestId("panel-resize-handle").boundingBox();
  if (!h) throw new Error("no handle");
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 6 });
  // Past the threshold mid-drag: the panel is wider, the groups still stacked.
  await expect.poll(async () => (await rect(page.getByTestId("side-panel-wrapper"))).width).toBeGreaterThan(730);
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await page.mouse.up();
  await expect(split(page)).toHaveAttribute("data-orientation", "side");

  // Back under it: side by side until the release.
  const h2 = await page.getByTestId("panel-resize-handle").boundingBox();
  if (!h2) throw new Error("no handle");
  await page.mouse.move(h2.x + h2.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(h2.x + h2.width / 2 + 150, y, { steps: 6 });
  await expect.poll(async () => (await rect(page.getByTestId("side-panel-wrapper"))).width).toBeLessThan(700);
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  await page.mouse.up();
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
});

test("dragging the divider sets the persisted ratio, within each group's minimum; keys move it; a double-click resets it", async ({ page }) => {
  await worktreeAndDiff(page, 760);
  await page.keyboard.press("Meta+Backslash");
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  expect((await entry(page)).ratio).toBeUndefined();

  // Side by side: dragging the 1px line (its hit area is wider) 60px left.
  const s = await rect(split(page));
  let d = await rect(divider(page));
  await page.mouse.move(d.left + 3, d.top + 200);
  await expect(divider(page)).toHaveCSS("cursor", "col-resize");
  await page.mouse.down();
  await expect(divider(page)).toHaveAttribute("data-dragging", "true");
  await page.mouse.move(d.left - 60, d.top + 200, { steps: 5 });
  await page.mouse.up();
  await expect(divider(page)).not.toHaveAttribute("data-dragging");
  const size = s.width - 1;
  const want = (d.left - 60 - s.left) / size;
  await expect.poll(async () => (await entry(page)).ratio ?? 0).toBeCloseTo(want, 2);
  await expect.poll(async () => (await persisted(page, "thread:s-1"))?.ratio ?? 0).toBeCloseTo(want, 2);
  const g0 = await rect(group(page, 0));
  expect(Math.abs(g0.width - want * size)).toBeLessThan(2);
  await expect(divider(page)).toHaveAttribute("aria-valuenow", String(Math.round(want * 100)));

  // Far past the left: the first group keeps its 280px minimum.
  d = await rect(divider(page));
  await page.mouse.move(d.left, d.top + 200);
  await page.mouse.down();
  await page.mouse.move(s.left + 20, d.top + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await rect(group(page, 0))).width).toBeGreaterThanOrEqual(279);
  await expect.poll(async () => (await entry(page)).ratio ?? 0).toBeCloseTo(280 / size, 2);

  // Keys: Right moves it 16px; Home and End go to the bounds.
  await divider(page).focus();
  const before = (await entry(page)).ratio ?? 0;
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await entry(page)).ratio ?? 0).toBeCloseTo(before + 16 / size, 2);
  await page.keyboard.press("End");
  await expect.poll(async () => (await entry(page)).ratio ?? 0).toBeCloseTo(1 - 280 / size, 2);

  // A double-click resets it (no stored ratio: the middle).
  await divider(page).dblclick();
  await expect.poll(async () => (await entry(page)).ratio).toBeUndefined();
  await expect.poll(async () => (await persisted(page, "thread:s-1"))?.ratio).toBeUndefined();

  // Stacked: the same ratio on the other axis, dragged vertically.
  await setPanelWidth(page, 420);
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  const ss = await rect(split(page));
  d = await rect(divider(page));
  await expect(divider(page)).toHaveCSS("cursor", "row-resize");
  await page.mouse.move(d.left + 200, d.top);
  await page.mouse.down();
  await page.mouse.move(d.left + 200, d.top + 80, { steps: 5 });
  await page.mouse.up();
  const vsize = ss.height - 1;
  await expect.poll(async () => (await entry(page)).ratio ?? 0).toBeCloseTo((d.top + 80 - ss.top) / vsize, 2);
  const [a, b] = await Promise.all([rect(group(page, 0)), rect(group(page, 1))]);
  expect(a.height).toBeGreaterThan(b.height);
  // Survives a reload.
  const kept = (await entry(page)).ratio;
  await page.reload();
  await row(page, "s:s-1").click();
  await expect(split(page)).toHaveAttribute("data-split", "true");
  expect((await entry(page)).ratio).toBe(kept);
});

test("each group has its own + and picker; cmd+alt+\\ moves between groups; cmd+w on an empty group collapses the split", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+Shift+e");
  await setPanelWidth(page, 420);
  await openThreadChanges(page);
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
  await panel(page).click({ position: { x: 200, y: 300 } });

  // One tab: the split keeps it, and the new second group starts on its surface list, focused.
  await page.keyboard.press("Meta+Backslash");
  await expect(split(page)).toHaveAttribute("data-split", "true");
  await expect(tabsOf(page, 0)).toHaveText(["Changes"]);
  await expect(tabsOf(page, 1)).toHaveCount(0);
  await expect(group(page, 1)).toHaveAttribute("data-picking", "true");
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(group(page, 0)).not.toHaveAttribute("data-picking");
  await expect(group(page, 1).getByTestId("panel-new-tab")).toHaveAttribute("aria-pressed", "true");
  await expect(group(page, 1).getByTestId("panel-empty")).toBeVisible();

  // cmd+w there collapses the split, back to the one group.
  await page.keyboard.press("Meta+w");
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(panel(page).getByRole("tab")).toHaveText(["Changes"]);
  await expect.poll(() => region(page)).toBe("panel");

  // Again, and a tab opened from elsewhere (a path chip's File tab) lands in the focused (second) group.
  await page.keyboard.press("Meta+Backslash");
  await expect(group(page, 1)).toHaveAttribute("data-picking", "true");
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: `${CF}/README.md` })}))`);
  await expect(tabsOf(page, 1)).toHaveText(["README.md"]);
  await expect(group(page, 1).getByTestId("panel-body")).toHaveAttribute("data-surface", "files");
  await expect(tabsOf(page, 0)).toHaveText(["Changes"]);
  await expect(group(page, 1)).not.toHaveAttribute("data-picking");

  // The first group's "+": that group picks (and takes focus); the second is untouched; Escape goes back.
  await group(page, 0).getByTestId("panel-new-tab").click();
  await expect(group(page, 0)).toHaveAttribute("data-picking", "true");
  await expect(group(page, 0)).toHaveAttribute("data-focused", "true");
  await expect(group(page, 1)).not.toHaveAttribute("data-picking");
  await expect(group(page, 1).getByTestId("panel-body")).toHaveAttribute("data-surface", "files");
  await page.keyboard.press("Escape");
  await expect(group(page, 0)).not.toHaveAttribute("data-picking");
  await expect(group(page, 0).getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");

  // The second group's "+", then Escape: back to its tab.
  await group(page, 1).getByTestId("panel-new-tab").click();
  await expect(group(page, 1)).toHaveAttribute("data-picking", "true");
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Escape");
  await expect(group(page, 1)).not.toHaveAttribute("data-picking");
  await expect(group(page, 1).getByTestId("panel-body")).toHaveAttribute("data-surface", "files");

  // A click in a group's body (its padding: a row would open its diff) focuses that group.
  await group(page, 0).getByTestId("panel-body").click({ position: { x: 4, y: 4 } });
  await expect(group(page, 0)).toHaveAttribute("data-focused", "true");
  // cmd+alt+\ moves the keyboard to the other group, and back.
  await page.keyboard.press("Meta+Alt+Backslash");
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect.poll(() => focusedGroupEl(page)).toBe("1");
  await page.keyboard.press("Meta+Alt+Backslash");
  await expect(group(page, 0)).toHaveAttribute("data-focused", "true");
  await expect.poll(() => focusedGroupEl(page)).toBe("0");

  // Closing a group's last tab collapses the split; focus stays in the panel.
  await page.keyboard.press("Meta+Alt+Backslash");
  await page.keyboard.press("Meta+w");
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(panel(page).getByRole("tab")).toHaveText(["Changes"]);
  await expect.poll(() => region(page)).toBe("panel");
});

/** SHOTS=<dir>: mock screenshots of a split panel, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`split screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const shot = (name: string) => page.screenshot({ path: `${String(shots)}/${name}-${scheme}.png` });
    await page.emulateMedia({ colorScheme: scheme });
    await worktreeAndDiff(page);
    await page.keyboard.press("Meta+Backslash");
    await page.mouse.move(0, 0);
    await shot("split-stack");
    await setPanelWidth(page, 760);
    await shot("split-side");
    await panel(page).getByTestId("panel-expand").click();
    await page.mouse.move(0, 0);
    await shot("split-expanded");
  });
}
