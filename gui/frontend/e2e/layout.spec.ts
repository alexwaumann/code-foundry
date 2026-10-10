import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, row, selectProject } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

function bg(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** Computed `--wails-draggable` of the element (inherited), "" when unset. */
function drag(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim());
}

// Window geometry (components/window/titleBand.ts): a 52px title band with no full-width
// strip. The sidebar's band (80px traffic-light gutter, then the Threads header) is
// 52px; the panes start 8px down and their 44px headers end on the band (their 1px
// bottom border is the first row below it: the pane's own 1px border puts the header
// at 9..53).
const BAND = 52;
const HEADER = 44;

test("the sidebar band holds the empty traffic-light gutter and the Threads header, and drags the window", async ({ page }) => {
  await openApp(page);
  const viewport = page.viewportSize();
  const band = await box(page, "sidebar-band");
  expect(band.top).toBe(0);
  expect(band.left).toBe(0);
  expect(band.height).toBe(BAND);
  expect(band.width).toBe((await box(page, "sidebar")).width);
  expect(await drag(page, '[data-testid="sidebar-band"]')).toBe("drag");

  const gutter = await box(page, "traffic-light-gutter");
  expect([gutter.left, gutter.top, gutter.width, gutter.height]).toEqual([0, 0, 80, BAND]);
  // Nothing sits on the lights.
  expect(await page.getByTestId("traffic-light-gutter").evaluate((el) => [el.childElementCount, el.textContent])).toEqual([0, ""]);
  const title = page.getByTestId("sidebar-band").getByText("Threads");
  expect(await title.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(80);
  expect(await drag(page, '[data-testid="sidebar-band"] header > span:first-child')).toBe("drag");
  // Its controls click instead of dragging.
  expect(await drag(page, '[data-testid="sidebar-band-controls"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="sidebar-new-terminal"]')).toBe("no-drag");
  // Pull Requests, Projects and the thread list sit below the band and do not drag.
  expect((await box(page, "nav-pullrequests")).top).toBeGreaterThanOrEqual(BAND);
  expect(await drag(page, '[data-testid="nav-pullrequests"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="nav-projects"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="thread-list"]')).toBe("");

  // The sheet above the panes drags too; the panes themselves do not.
  const edge = await box(page, "window-drag-edge");
  expect([edge.top, edge.left, edge.width, edge.height]).toEqual([0, 0, viewport?.width, 8]);
  expect(await drag(page, '[data-testid="window-drag-edge"]')).toBe("drag");
  expect(await drag(page, '[data-testid="content-pane"]')).toBe("");
});

test("the panes start 8px from the top and their 44px headers drag the window, with the sidebar shown and hidden", async ({ page }) => {
  await openApp(page);
  const viewport = page.viewportSize();
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.getByTestId("terminal-header").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();

  for (const visible of [true, false]) {
    if (!visible) {
      await page.keyboard.press("Meta+b");
      await expect(page.getByTestId("sidebar")).toHaveCount(0);
    }
    const pane = await box(page, "content-pane");
    expect(pane.top).toBe(8);
    expect(pane.left).toBe(visible ? (await box(page, "sidebar")).right + 8 : 8);
    expect(viewport && viewport.height - pane.bottom).toBe(8);

    const header = await box(page, "terminal-header");
    expect(header.top).toBe(pane.top + 1);
    expect(header.height).toBe(HEADER);
    expect(header.bottom - 1).toBe(BAND);
    expect(await drag(page, '[data-testid="terminal-header"]')).toBe("drag");
    expect(await drag(page, '[data-testid="terminal-title"]')).toBe("drag");
    expect(await drag(page, '[data-testid="pane-actions"]')).toBe("no-drag");
    // The terminal itself never drags.
    expect(await drag(page, '[data-testid="terminal-host"]')).toBe("");

    // The side panel: same top, same header, ending on the band.
    const wrapper = await box(page, "side-panel-wrapper");
    expect(wrapper.top).toBe(8);
    expect(viewport && viewport.width - wrapper.right).toBe(8);
    const panelHeader = await box(page, "panel-header");
    expect(panelHeader.top).toBe(header.top);
    expect(panelHeader.height).toBe(HEADER);
    expect(panelHeader.bottom).toBe(header.bottom);
    expect(await drag(page, '[data-testid="panel-header"]')).toBe("drag");
    expect(await drag(page, '[data-testid="panel-header"] [data-testid="panel-toggle"]')).toBe("no-drag");
    expect(await drag(page, '[data-testid="panel-empty"]')).toBe("");
    // The resize handle runs from the panel's top (just below the window's 8px edge) and never drags.
    const handle = await box(page, "panel-resize-handle");
    expect(handle.top).toBe(8);
    expect(await drag(page, '[data-testid="panel-resize-handle"]')).toBe("no-drag");

    // Hidden sidebar: the pane runs under the traffic lights, so the header content
    // starts past the gutter.
    const title = await box(page, "terminal-title");
    if (!visible) expect(title.left).toBeGreaterThanOrEqual(80 + 8);
  }
  await expect(page.getByTestId("hints")).toHaveCount(0);
});

test("every page header is 44px, ends on the band and drags; its controls do not", async ({ page }) => {
  await openApp(page);
  const check = async (header: string, noDrag: string[]) => {
    const h = await page.locator(header).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, bottom: r.bottom };
    });
    expect(h, header).toEqual({ top: 9, height: HEADER, bottom: BAND + 1 });
    expect(await drag(page, header)).toBe("drag");
    for (const sel of noDrag) expect(await drag(page, `${header} ${sel}`), sel).toBe("no-drag");
  };

  await selectProject(page, "repo-cf");
  await check('[data-testid="overview-page"] > header', ['[data-testid="panel-toggle"]']);
  await page.getByTestId("nav-pullrequests").click();
  await check('[data-testid="prs-page"] > header', ['[data-testid="prs-scope"]', '[data-testid="panel-toggle"]']);
  await page.getByTestId("nav-projects").click();
  await check('[data-testid="projects-page"] > header', ['[data-testid="projects-register"]', '[data-testid="panel-toggle"]']);
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await check('[data-testid="settings-page"] > header', ['input[type="search"]', '[data-testid="reveal-settings"]', 'button[aria-label="Close settings"]']);
  await page.getByRole("button", { name: "Close settings" }).click();

  // A disconnected thread has no header: its panel toggle sits centred where one would be.
  await row(page, "s:s-3").click();
  await expect(page.getByTestId("session-disconnected")).toBeVisible();
  const toggle = await box(page, "panel-toggle");
  expect((toggle.top + toggle.bottom) / 2).toBe((9 + BAND + 1) / 2);
  expect(await drag(page, '[data-testid="panel-toggle"]')).toBe("no-drag");
});

test("the daemon status and update indicator sit at the bottom of the sidebar", async ({ page }) => {
  await openApp(page);
  const sidebar = await box(page, "sidebar");
  const status = await box(page, "daemon-status");
  expect(status.left).toBeGreaterThanOrEqual(sidebar.left);
  expect(status.right).toBeLessThanOrEqual(sidebar.right);
  expect(sidebar.bottom - status.bottom).toBeLessThan(16);
  await expect(page.locator("footer")).toHaveCount(0);
});

for (const scheme of ["dark", "light"] as const) {
  test(`${scheme}: sidebar sits on the sheet and the terminal matches its pane`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/);
    const sheet = await bg(page, "body");
    expect(await bg(page, '[data-testid="sidebar"]')).toBe(sheet);
    const pane = await bg(page, '[data-testid="content-pane"]');
    expect(pane).not.toBe(sheet);
    expect(await page.getByTestId("sidebar").evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("0px");

    await row(page, "s:s-1").click();
    await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
    // The xterm theme background (src/terminal/theme.ts) must be the pane colour.
    const xtermBg = () =>
      page.evaluate(() => {
        const w = window as unknown as { __cfTerminal?: { renderer: { term: { options: { theme?: { background?: string } } } } } };
        const probe = document.createElement("div");
        probe.style.backgroundColor = w.__cfTerminal?.renderer.term.options.theme?.background ?? "";
        document.body.append(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      });
    await expect.poll(xtermBg).toBe(pane);
    expect(await bg(page, '[data-testid="terminal-host"] >> xpath=..')).toBe(pane);
  });
}
