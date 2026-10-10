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
// strip. The sidebar's band (80px traffic-light gutter, then the app name) is
// 52px; the panes start 8px down and their 44px headers end on the band (their 1px
// bottom border is the first row below it: the pane's own 1px border puts the header
// at 9..53).
const BAND = 52;
const HEADER = 44;

test("the app name is 16px semibold and fits whole at the minimum sidebar width, zoomed out too", async ({ page }) => {
  await openApp(page);
  const title = page.getByTestId("sidebar-app-name");
  await expect(title).toHaveCSS("font-size", "16px");
  await expect(title).toHaveCSS("font-weight", "600");
  const setWidth = (w: number) => page.evaluate(`import("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setSidebarWidth(${String(w)}))`);
  const setZoom = (z: number) => page.evaluate(`import("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setZoom(${String(z)}))`);
  const fits = () => title.evaluate((el) => el.scrollWidth <= el.clientWidth);
  await setWidth(220);
  await expect.poll(async () => (await box(page, "sidebar")).width).toBe(220);
  expect(await fits()).toBe(true);
  // Zoomed out, the gutter is wider in layout px (80 screen px over 0.9): the tightest case.
  await setZoom(90);
  await expect(page.getByTestId("traffic-light-gutter")).toHaveAttribute("style", /width: 89px/);
  expect(await fits()).toBe(true);
  await expect(title).toBeVisible();
});

test("the sidebar band holds only the empty traffic-light gutter and the app name, and drags the window", async ({ page }) => {
  await openApp(page);
  const viewport = page.viewportSize();
  const band = await box(page, "sidebar-band");
  expect(band.top).toBe(0);
  expect(band.left).toBe(0);
  expect(band.height).toBe(BAND);
  expect(band.width).toBe((await box(page, "sidebar")).width);
  expect(await drag(page, '[data-testid="sidebar-band"]')).toBe("drag");
  await expect(page.getByTestId("sidebar-band").locator("button")).toHaveCount(0);

  const gutter = await box(page, "traffic-light-gutter");
  expect([gutter.left, gutter.top, gutter.width, gutter.height]).toEqual([0, 0, 80, BAND]);
  // Nothing sits on the lights.
  expect(await page.getByTestId("traffic-light-gutter").evaluate((el) => [el.childElementCount, el.textContent])).toEqual([0, ""]);
  const title = page.getByTestId("sidebar-app-name");
  await expect(title).toHaveText("Code Foundry");
  // 12px after the gutter.
  expect(await title.evaluate((el) => el.getBoundingClientRect().left)).toBe(80 + 12);
  expect(await drag(page, '[data-testid="sidebar-app-name"]')).toBe("drag");

  // The toolbar sits right under the band, 32px tall, its buttons in order from 12px in; it does not drag.
  const toolbar = await box(page, "sidebar-toolbar");
  expect([toolbar.top, toolbar.left, toolbar.height]).toEqual([BAND, 0, 32]);
  expect(await drag(page, '[data-testid="sidebar-toolbar"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="sidebar-new-session"]')).toBe("no-drag");
  const buttons = await page
    .getByTestId("sidebar-toolbar")
    .locator("button")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(buttons).toEqual(["sidebar-dashboard", "sidebar-notifications", "sidebar-add-project", "sidebar-new-session"]);
  expect((await box(page, "sidebar-dashboard")).left).toBe(12);
  // New terminal is not in the sidebar (palette, cmd+t and the row menu only).
  await expect(page.getByTestId("sidebar-new-terminal")).toHaveCount(0);
  // Pull Requests, Projects and the thread list sit below the toolbar and do not drag.
  expect((await box(page, "nav-pullrequests")).top).toBeGreaterThanOrEqual(BAND + 32);
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

test("headerless panes (start page, composer) drag the window from the same 44px band", async ({ page }) => {
  await openApp(page);
  const check = async (band: string, content: string) => {
    const b = await page.locator(band).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, bottom: r.bottom };
    });
    expect(b, band).toEqual({ top: 9, height: HEADER, bottom: BAND + 1 });
    expect(await drag(page, band)).toBe("drag");
    expect(await drag(page, content)).toBe("");
  };
  await expect(page.getByTestId("start-page")).toBeVisible();
  await check('[data-testid="start-page"] ~ [data-testid="pane-drag-band"]', '[data-testid="welcome-actions"]');
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await check('[data-testid="composer"] ~ [data-testid="pane-drag-band"]', '[data-testid="composer-card"]');
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
