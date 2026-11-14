import { expect, test, type Page } from "@playwright/test";
import { openApp, openHelloDemo, resetMock, row } from "./fixtures";
import { activeOfKind, dragGutterBeside, paneShowingSurface, setSurfaceWidth } from "./shell-surfaces";

/**
 * Plugin surfaces, consent and Settings → Plugins (docs/notes/plugins-5-gui.md) against the
 * mock's plugins (mock/plugins.ts): hello running with its demo surface (the captured
 * views of the real example), crasher crashed, acme-data disabled and never consented.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);

/** Thread s-3 open, the hello demo (opened from the palette) in a tab beside it. */
async function openDemo(page: Page): Promise<void> {
  await openHelloDemo(page);
  await expect(activeOfKind(page, "plugin.hello.demo")).toHaveCount(1);
}

/** The demo's pane as wide as the side panel was (420 px), to widen from. */
const narrow = (page: Page) => setSurfaceWidth(page, "plugin-surface", 420);

/** Drags the gutter left of the demo's pane 500 px left: the pane widens, as the panel's edge did. */
const widen = (page: Page) => dragGutterBeside(page, "plugin-surface", -500, 6);

/** The body of the pane showing the demo. */
const paneBody = (page: Page) => paneShowingSurface(page, "plugin-surface").getByTestId("shell-pane-body");

test.beforeEach(async () => {
  await resetMock();
});

// The demo's header, tabs and tab title, every node kind, rows and chips, a section collapsing;
// acts and command buttons with the daemon's confirm; a tab's choice, log tones and appended lines;
// the form's host checks, drafts across tabs, the multi-select, the values sent and a stored secret;
// the surface list and a surface the daemon makes available; a plugin going down and its restart;
// ShowView with a thread and an InvokeCommand intent's confirm naming the plugin:
// src/components/plugin/PluginSurface.test.tsx, registry.test.tsx, renderer.test.tsx, form.test.ts.
// The hello plugin's own answers (its next views, "Saved: …", Pin) are the mock plugin's.

// Settings → Plugins' rows, groups, menus, pid, env names, last error, logs, the consent's title
// and permissions, Cancel and Enable: src/components/plugin/settings/PluginsPage.test.tsx and
// src/components/plugin/ConsentDialog.test.tsx. Here the flow across routes once it is enabled.
test("Settings → Plugins: a plugin's surface opened from its row closes Settings and shows live beside the thread", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-nav-plugins").click();
  const acme = page.getByTestId("plugin-row-settings").and(page.locator('[data-plugin="acme-data"]'));
  await acme.getByTestId("plugin-switch").click();
  await page.getByTestId("consent-dialog").getByTestId("consent-enable").click();
  await expect(acme.getByTestId("plugin-switch")).toBeChecked();
  await acme.getByTestId("plugin-row-menu").click();
  await page.getByTestId("plugin-menu-surface-access").click();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(activeOfKind(page, "plugin.acme-data.access")).toHaveCount(1);
  await expect(surface(page).getByTestId("plugin-title")).toHaveText("Data access");
});

test("the layout tab: columns stack in a narrow pane and sit side by side once it is wide enough; collapse first adds the thread there", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDemo(page);
  await narrow(page);
  await tab(page, "layout").click();
  await expect(tab(page, "layout")).toHaveAttribute("aria-selected", "true");
  const cols = surface(page).locator('[data-testid="plugin-columns"][data-key="layout-cols"]');
  const detail = surface(page).locator('[data-testid="plugin-columns"][data-key="layout-detail"]');
  await expect(cols).toHaveAttribute("data-layout", "stack");
  await expect(detail.getByTestId("plugin-column")).toHaveCount(1);
  await expect(surface(page).getByTestId("plugin-thread")).toHaveCount(0);
  // Stacked: the right column (markdown) sits under the left one (the pane).
  const left = cols.locator('[data-testid="plugin-column"][data-key="layout-left"]');
  const right = cols.locator('[data-testid="plugin-column"][data-key="layout-right"]');
  let l = await left.boundingBox();
  let r = await right.boundingBox();
  expect(r && l && r.y >= l.y + l.height).toBe(true);
  // The pane is 320 px and scrolls its log and list inside.
  const pane = surface(page).locator('[data-testid="plugin-pane"][data-key="layout-pane"]');
  expect(Math.round((await pane.boundingBox())?.height ?? 0)).toBe(320);
  expect(await pane.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // Widen the pane past 2 × 240 + 12 px.
  await widen(page);
  await expect(cols).toHaveAttribute("data-layout", "row");
  l = await left.boundingBox();
  r = await right.boundingBox();
  expect(l && r && Math.round(r.x - (l.x + l.width))).toBe(12);
  expect(l && r && Math.abs(r.y - l.y) < 1).toBe(true);
  // Weight 2 beside weight 1.
  expect(l && r && Math.abs(l.width - 2 * r.width) < 2).toBe(true);
  await expect(detail.getByTestId("plugin-column")).toHaveCount(2);
  const thread = detail.getByTestId("plugin-thread");
  await expect(thread).toHaveAttribute("data-thread-id", "s-hello-assistant");
  // The thread fills its fill pane, which fills the rest of the surface (at least its 320 px
  // minHeight) above the footer: the body scrolls between the toolbar and the footer.
  const chat = detail.locator('[data-testid="plugin-pane"][data-key="layout-chat-pane"]');
  const c = await chat.boundingBox();
  const t = await thread.boundingBox();
  expect(c && c.height >= 320).toBe(true);
  expect(c && t && Math.abs(t.y + t.height - (c.y + c.height)) < 2).toBe(true);
  const scroll = surface(page).getByTestId("plugin-scroll");
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const cAtEnd = await chat.boundingBox();
  const foot = await surface(page).getByTestId("plugin-footer").boundingBox();
  expect(cAtEnd && foot && Math.abs(foot.y - 16 - (cAtEnd.y + cAtEnd.height)) < 2).toBe(true);
});

test("the layout tab's toolbar and footer stay pinned while the body scrolls between them", async ({ page }) => {
  await openDemo(page);
  await tab(page, "layout").click();
  const toolbar = surface(page).getByTestId("plugin-toolbar");
  const footer = surface(page).getByTestId("plugin-footer");
  await expect(toolbar).toBeVisible();
  await expect(footer).toBeVisible();
  // Under the plugin's tabs, at the bottom of the pane; a hairline toward the body.
  const tabsBox = await surface(page).getByTestId("plugin-tabs").boundingBox();
  const panelBody = await paneBody(page).boundingBox();
  const tb = await toolbar.boundingBox();
  const ft = await footer.boundingBox();
  expect(tabsBox && tb && Math.abs(tb.y - (tabsBox.y + tabsBox.height)) < 1).toBe(true);
  expect(panelBody && ft && Math.abs(ft.y + ft.height - (panelBody.y + panelBody.height)) < 1).toBe(true);
  expect(await toolbar.evaluate((el) => [getComputedStyle(el).borderBottomWidth, getComputedStyle(el).borderTopWidth])).toEqual(["1px", "0px"]);
  expect(await footer.evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderBottomWidth])).toEqual(["1px", "0px"]);
  expect(await toolbar.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("16px");
  // The body scrolls; the pane's own body does not, and the strips stay where they are.
  const scroll = surface(page).getByTestId("plugin-scroll");
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await paneBody(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  const sb = await scroll.boundingBox();
  expect(sb && tb && ft && Math.abs(sb.y - (tb.y + tb.height)) < 1 && Math.abs(sb.y + sb.height - ft.y) < 1).toBe(true);
  await scroll.evaluate((el) => {
    el.scrollTop = 400;
  });
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  const tb2 = await toolbar.boundingBox();
  const ft2 = await footer.boundingBox();
  expect(tb && tb2 && tb2.y === tb.y).toBe(true);
  expect(ft && ft2 && ft2.y === ft.y).toBe(true);

  // The toolbar's search on Enter, a chip, Clear and its reset token, no strips on another tab:
  // PluginSurface.test.tsx ("the layout tab"); the strips' contents: chrome.test.tsx.
});

test("the layout tab: the grid stacks in a narrow pane and goes to columns as it widens; dividers, inline groups and a flex spacer", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDemo(page);
  await narrow(page);
  await tab(page, "layout").click();
  await expect(tab(page, "layout")).toHaveAttribute("aria-selected", "true");
  const grid = surface(page).locator('[data-testid="plugin-grid"][data-key="layout-grid"]');
  const cell = (key: string) => grid.locator(`[data-testid="plugin-grid-item"][data-key="${key}"]`);
  await expect(grid).toHaveAttribute("data-columns", "1");
  // Stacked in the narrow pane: one card under the other, the span-2 card one column wide.
  let a = await cell("layout-cell-build").boundingBox();
  let b = await cell("layout-cell-tests").boundingBox();
  let d = await cell("layout-cell-deploy").boundingBox();
  expect(a && b && b.y >= a.y + a.height && Math.abs(a.x - b.x) < 1 && Math.abs(a.width - b.width) < 1).toBe(true);
  expect(a && d && Math.abs(a.width - d.width) < 1).toBe(true);

  // The labelled divider centres its label between two hairlines.
  const rule = surface(page).locator('[data-testid="plugin-divider"][data-key="layout-grid-rule"]');
  const r = await rule.boundingBox();
  const label = await rule.getByTestId("plugin-divider-label").boundingBox();
  expect(r && label && Math.abs(label.x + label.width / 2 - (r.x + r.width / 2)) < 2).toBe(true);
  await expect(rule.getByTestId("plugin-divider-label")).toHaveText("Grid");

  // Group "between": the text at the start, the buttons at the end, on one line.
  const line = surface(page).locator('[data-testid="plugin-group"][data-key="layout-line"]');
  const lineBox = await line.boundingBox();
  const lt = await line.locator('[data-testid="plugin-group-item"][data-key="layout-line-text"]').boundingBox();
  const lb = await line.locator('[data-testid="plugin-group-item"][data-key="layout-line-bar"]').boundingBox();
  expect(lineBox && lt && lb && Math.abs(lt.x - lineBox.x) < 1 && Math.abs(lb.x + lb.width - (lineBox.x + lineBox.width)) < 1).toBe(true);
  expect(lt && lb && Math.abs(lt.y + lt.height / 2 - (lb.y + lb.height / 2)) < 1.5).toBe(true);
  // Group "start": chips then the progress bar 8 px after them.
  const steps = surface(page).locator('[data-testid="plugin-group"][data-key="layout-steps"]');
  const sc = await steps.locator('[data-testid="plugin-group-item"][data-key="layout-steps-chips"]').boundingBox();
  const sp = await steps.locator('[data-testid="plugin-group-item"][data-key="layout-steps-progress"]').boundingBox();
  expect(sc && sp && Math.round(sp.x - (sc.x + sc.width))).toBe(8);
  expect(sp && sp.width >= 160).toBe(true);

  // The flex spacer keeps the bar at the bottom of its 180 px pane.
  const pushPane = surface(page).locator('[data-testid="plugin-pane"][data-key="layout-push-pane"]');
  const bottomOf = async () => {
    const p = await pushPane.boundingBox();
    const bar = await pushPane.locator('[data-testid="plugin-group"][data-key="layout-push-bar"]').boundingBox();
    return p && bar ? Math.round(p.y + p.height - (bar.y + bar.height)) : null;
  };
  expect(Math.round((await pushPane.boundingBox())?.height ?? 0)).toBe(180);
  expect(await bottomOf()).toBe(0);
  await expect(pushPane.locator('[data-testid="plugin-spacer"][data-key="layout-push-spacer"]')).toHaveAttribute("data-flex", "true");
  // The fixed spacer is 24 px (on top of the 12 px gap, which it takes back once).
  const gap = surface(page).locator('[data-testid="plugin-spacer"][data-key="layout-gap"]');
  await expect(gap).not.toHaveAttribute("data-flex", "true");
  expect(Math.round((await gap.boundingBox())?.height ?? 0)).toBe(24);

  // Widen the pane: as many 200 px columns as fit, 12 px apart.
  await widen(page);
  await expect(grid).not.toHaveAttribute("data-columns", "1");
  const width = (await grid.boundingBox())?.width ?? 0;
  const cols = Math.min(6, Math.max(1, Math.floor((width + 12) / (200 + 12))));
  expect(cols).toBeGreaterThanOrEqual(2);
  await expect(grid).toHaveAttribute("data-columns", String(cols));
  a = await cell("layout-cell-build").boundingBox();
  b = await cell("layout-cell-tests").boundingBox();
  d = await cell("layout-cell-deploy").boundingBox();
  expect(a && b && Math.round(b.x - (a.x + a.width))).toBe(12);
  expect(a && b && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1).toBe(true);
  // The deploy card spans two columns and their gap.
  expect(a && d && Math.abs(d.width - (2 * a.width + 12)) < 2).toBe(true);
  // Cards in a row line up: as tall as the row.
  const cardH = async (key: string) => (await cell(key).getByTestId("plugin-section").boundingBox())?.height ?? 0;
  expect(Math.abs((await cardH("layout-cell-build")) - (await cardH("layout-cell-tests")))).toBeLessThan(1);
  expect(await bottomOf()).toBe(0);
});

test("the runs tab: the back button and the row take the keyboard; the log pane's height; side by side when wide", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDemo(page);
  await narrow(page);
  await tab(page, "run-list").click();
  await expect(tab(page, "run-list")).toHaveAttribute("aria-selected", "true");
  const md = surface(page).locator('[data-testid="plugin-master-detail"][data-key="runs-md"]');
  const runRow = (n: number) => md.locator(`[data-testid="plugin-row"][data-key="runs-run-${String(n)}"]`);
  // The list, the select act, the detail's back button and title, its node tabs' acts and drafts, Back
  // sending nothing: src/components/plugin/masterdetail.test.tsx. Here the focus and the geometry.
  await expect(md).toHaveAttribute("data-layout", "narrow");
  // Choose a run: the back button takes the keyboard.
  await runRow(5).click();
  const back = md.getByTestId("plugin-md-back");
  await expect(back).toBeFocused();
  // The detail's Log tab: its pane is 240 px.
  const nodeTab = (key: string) => md.locator(`[data-testid="plugin-node-tab"][data-key="${key}"]`);
  await nodeTab("runs-tab-log").click();
  const logPane = md.locator('[data-testid="plugin-pane"][data-key="runs-log-pane"]');
  await expect(logPane).toBeVisible();
  expect(Math.round((await logPane.boundingBox())?.height ?? 0)).toBe(240);
  await nodeTab("runs-tab-overview").click();
  // Back: focus on the run's row.
  await back.click();
  await expect(runRow(5)).toBeFocused();

  // Widen the pane past 280 + 12 + 320 px: the list beside the detail, each scrolling.
  await widen(page);
  await expect(md).toHaveAttribute("data-layout", "wide");
  const list = md.getByTestId("plugin-md-list");
  const detail = md.getByTestId("plugin-md-detail");
  const box = await md.boundingBox();
  const l = await list.boundingBox();
  const d = await detail.boundingBox();
  // The list side is 280 px (and its rows' 8 px overhang); the detail's content starts 12 px after it.
  expect(box && l && Math.round(l.x + l.width - box.x)).toBe(280);
  expect(box && d && Math.round(d.x + 8 - box.x)).toBe(292);
  expect(l && d && Math.abs(l.y - d.y) < 1).toBe(true);
  expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  expect(await detail.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  await expect(md.getByTestId("plugin-md-back")).toHaveCount(0);
  await expect(md.getByTestId("plugin-pairs")).toContainText("cf/fix");
  // Another run in place; the detail keeps its tab.
  await runRow(4).click();
  await expect(md).toHaveAttribute("data-selected", "runs-run-4");
  await expect(md.getByTestId("plugin-pairs")).toContainText("main");
  await expect(runRow(4)).toHaveAttribute("data-selected", "true");
  await expect(runRow(5)).not.toHaveAttribute("data-selected", "true");
});
