import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

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

// Window geometry (components/window/titleBand.ts, docs/notes/design-system-2-shell.md):
// a 56px title band with no full-width strip. The sidebar's band (80px traffic-light
// gutter, then the app name) is 56px; the panes start a shell gap (12px) down and their
// 44px headers end on the band (their 1px bottom border is the first row below it: the
// pane's own 1px border puts the header at 13..57). The band's content centres on the
// header, 34px down.
const GAP = 12;
const BAND = 56;
const HEADER = 44;
const CENTER = 34;
/** An icon-xs button's inset around its glyph: (24px box - 14px glyph) / 2. */
const ICON_INSET = 5;

test("the app name is text-brand (17px semibold) and fits whole at the minimum sidebar width, zoomed in and out", async ({ page }) => {
  await openApp(page);
  const title = page.getByTestId("sidebar-app-name");
  await expect(title).toHaveCSS("font-size", "17px");
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
  await setZoom(150);
  await expect(page.getByTestId("traffic-light-gutter")).toHaveAttribute("style", /width: 53px/);
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
  // 12px after the gutter, centred on the pane headers (34px down), not on the band.
  expect(await title.evaluate((el) => el.getBoundingClientRect().left)).toBe(80 + 12);
  const name = await box(page, "sidebar-app-name");
  expect(name.top + name.height / 2).toBe(CENTER);
  expect(await drag(page, '[data-testid="sidebar-app-name"]')).toBe("drag");

  // The toolbar sits right under the band, 32px tall, in the sidebar body's 12px left gutter
  // with no inset of its own (#40: rows, toolbar and status run to the sidebar's edges, a
  // shell gap from the window and from the pane), its buttons in order from there; it does
  // not drag.
  const toolbar = await box(page, "sidebar-toolbar");
  expect([toolbar.top, toolbar.left, toolbar.height]).toEqual([BAND, GAP, 32]);
  expect(await drag(page, '[data-testid="sidebar-toolbar"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="sidebar-new-session"]')).toBe("no-drag");
  const buttons = await page
    .getByTestId("sidebar-toolbar")
    .locator("button")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(buttons).toEqual(["sidebar-dashboard", "sidebar-notifications"]);
  // The first button's glyph (not its box) sits on the gutter line.
  expect((await box(page, "sidebar-dashboard")).left).toBe(GAP - ICON_INSET);
  expect(await page.getByTestId("sidebar-dashboard").locator("svg").evaluate((el) => el.getBoundingClientRect().left)).toBe(GAP);
  // New thread is a full-width button under the toolbar: 12px from the window edge, and it
  // ends where the sidebar does (the content pane's 12px margin is the gap beyond it).
  const newThread = await box(page, "sidebar-new-session");
  const sidebar = await box(page, "sidebar");
  expect(newThread.left).toBe(GAP);
  expect(newThread.top).toBeGreaterThan(BAND + 32);
  expect(newThread.height).toBe(32);
  expect(newThread.left + newThread.width).toBe(sidebar.left + sidebar.width);
  // New terminal is not in the sidebar (palette, cmd+t and the row menu only).
  await expect(page.getByTestId("sidebar-new-terminal")).toHaveCount(0);
  // Pull Requests, Projects and the thread list sit below the toolbar and do not drag.
  expect((await box(page, "nav-pullrequests")).top).toBeGreaterThanOrEqual(BAND + 32);
  expect(await drag(page, '[data-testid="nav-pullrequests"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="nav-projects"]')).toBe("no-drag");
  expect(await drag(page, '[data-testid="thread-list"]')).toBe("");

  // The sheet above the panes drags too; the panes themselves do not.
  const edge = await box(page, "window-drag-edge");
  expect([edge.top, edge.left, edge.width, edge.height]).toEqual([0, 0, viewport?.width, GAP]);
  expect(await drag(page, '[data-testid="window-drag-edge"]')).toBe("drag");
  expect(await drag(page, '[data-testid="content-pane"]')).toBe("");
});

test("the panes start a shell gap (12px) from the top and their 44px headers drag the window, with the sidebar shown and hidden", async ({ page }) => {
  await openApp(page);
  const viewport = page.viewportSize();
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.getByTestId("thread-header").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();

  for (const visible of [true, false]) {
    if (!visible) {
      await page.keyboard.press("Meta+b");
      await expect(page.getByTestId("sidebar")).toHaveCount(0);
    }
    const pane = await box(page, "content-pane");
    expect(pane.top).toBe(GAP);
    expect(pane.left).toBe(visible ? (await box(page, "sidebar")).right + GAP : GAP);
    expect(viewport && viewport.height - pane.bottom).toBe(GAP);

    const header = await box(page, "thread-header");
    expect(header.top).toBe(pane.top + 1);
    expect(header.height).toBe(HEADER);
    expect(header.bottom - 1).toBe(BAND);
    // Its content (inside the 1px bottom border) centres 34.5px down, half a pixel below
    // the band's centre (the app name, the traffic lights).
    expect(Math.abs((header.top + header.bottom - 1) / 2 - CENTER)).toBeLessThanOrEqual(0.5);
    expect(await drag(page, '[data-testid="thread-header"]')).toBe("drag");
    // The name and the location are buttons (rename, worktree surface): they do not drag.
    expect(await drag(page, '[data-testid="thread-title"]')).toBe("no-drag");
    expect(await drag(page, '[data-testid="thread-location"]')).toBe("no-drag");
    expect(await drag(page, '[data-testid="pane-actions"]')).toBe("no-drag");
    // The conversation itself never drags.
    expect(await drag(page, '[data-testid="thread-timeline"]')).toBe("");

    // The side panel: same top, same header, ending on the band.
    const wrapper = await box(page, "side-panel-wrapper");
    expect(wrapper.top).toBe(GAP);
    expect(viewport && viewport.width - wrapper.right).toBe(GAP);
    const panelHeader = await box(page, "panel-header");
    expect(panelHeader.top).toBe(header.top);
    expect(panelHeader.height).toBe(HEADER);
    expect(panelHeader.bottom).toBe(header.bottom);
    expect(await drag(page, '[data-testid="panel-header"]')).toBe("drag");
    expect(await drag(page, '[data-testid="panel-header"] [data-testid="panel-toggle"]')).toBe("no-drag");
    expect(await drag(page, '[data-testid="panel-empty"]')).toBe("");
    // The resize handle runs from the panel's top (just below the window's 12px edge) and never drags.
    const handle = await box(page, "panel-resize-handle");
    expect(handle.top).toBe(GAP);
    expect(await drag(page, '[data-testid="panel-resize-handle"]')).toBe("no-drag");

    // Hidden sidebar: the pane runs under the traffic lights, so the header content
    // starts past the gutter.
    const title = await box(page, "thread-title");
    // (The name's button pulls its 6px hover padding into the header's own; its text starts past the gutter.)
    if (!visible) expect(title.left + 6).toBeGreaterThanOrEqual(80 + GAP);
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
    expect(h, header).toEqual({ top: GAP + 1, height: HEADER, bottom: BAND + 1 });
    expect(await drag(page, header)).toBe("drag");
    for (const sel of noDrag) expect(await drag(page, `${header} ${sel}`), sel).toBe("no-drag");
  };

  await page.getByTestId("nav-pullrequests").click();
  await check('[data-testid="prs-page"] > header', ['[data-testid="prs-scope"]', '[data-testid="panel-toggle"]']);
  await page.getByTestId("nav-projects").click();
  await check('[data-testid="projects-page"] > header', ['[data-testid="projects-register"]', '[data-testid="panel-toggle"]']);
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await check('[data-testid="settings-page"] > header', ['input[type="search"]', '[data-testid="reveal-settings"]', 'button[aria-label="Close settings"]']);
  await page.getByRole("button", { name: "Close settings" }).click();

  // A stopped thread keeps the thread header.
  await row(page, "s:s-3").click();
  await expect(page.getByTestId("thread-composer")).toBeVisible();
  await check('[data-testid="thread-header"]', ['[data-testid="pane-actions"]', '[data-testid="panel-toggle"]']);
});

test("headerless panes (start page, composer) drag the window from the same 44px band", async ({ page }) => {
  await openApp(page);
  const check = async (band: string, content: string) => {
    const b = await page.locator(band).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, bottom: r.bottom };
    });
    expect(b, band).toEqual({ top: GAP + 1, height: HEADER, bottom: BAND + 1 });
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
  // The last status button's glyph (not its box) ends on the sidebar's right edge, a shell
  // gap from the content pane.
  const settings = await box(page, "status-settings");
  expect(settings.right).toBe(sidebar.right + ICON_INSET);
  expect(await page.getByTestId("status-settings").locator("svg").evaluate((el) => el.getBoundingClientRect().right)).toBe(sidebar.right);
  expect((await box(page, "content-pane")).left - sidebar.right).toBe(GAP);
  // So does a footer header's chevron (its box) just above it.
  expect(await page.getByTestId("snoozed-header").locator("svg").evaluate((el) => el.getBoundingClientRect().right)).toBe(sidebar.right);
});

for (const scheme of ["dark", "light"] as const) {
  test(`${scheme}: sidebar sits on the sheet and the bottom panel's terminal matches its pane`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/);
    const sheet = await bg(page, "body");
    expect(await bg(page, '[data-testid="sidebar"]')).toBe(sheet);
    const pane = await bg(page, '[data-testid="content-pane"]');
    expect(pane).not.toBe(sheet);
    expect(await page.getByTestId("sidebar").evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("0px");

    // s-1's shell in its bottom panel: the xterm theme background (src/terminal/theme.ts)
    // must be the pane colour.
    await row(page, "s:s-1").click();
    await page.keyboard.press("Meta+j");
    await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-attach-phase", "live");
    expect(await bg(page, '[data-testid="bottom-panel"]')).toBe(pane);
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
    expect(await bg(page, '[data-testid="bottom-terminal-host"] >> xpath=..')).toBe(pane);
  });
}
