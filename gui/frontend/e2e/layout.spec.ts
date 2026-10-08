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

test("the title strip spans the window, drags it, and keeps the traffic-light gutter", async ({ page }) => {
  await openApp(page);
  const strip = page.getByTestId("title-strip");
  await expect(strip).toBeVisible();
  expect(await strip.evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim())).toBe("drag");
  const s = await box(page, "title-strip");
  const viewport = page.viewportSize();
  expect(s.top).toBe(0);
  expect(s.height).toBe(52);
  expect(s.width).toBe(viewport?.width);
  expect((await box(page, "traffic-light-gutter")).width).toBe(80);

  // The sidebar and the content pane start below the strip; hiding the sidebar keeps it.
  for (const visible of [true, false]) {
    if (!visible) {
      await page.keyboard.press("Meta+b");
      await expect(page.getByTestId("sidebar")).toHaveCount(0);
    } else {
      expect((await box(page, "sidebar")).top).toBeGreaterThanOrEqual(52);
    }
    const pane = await box(page, "content-pane");
    expect(pane.top).toBeGreaterThanOrEqual(52);
    expect(pane.left).toBeGreaterThanOrEqual(8);
    expect(viewport && viewport.width - pane.right).toBe(8);
    // No footer: the pane stops 8px above the window's bottom edge.
    expect(viewport && viewport.height - pane.bottom).toBe(8);
  }
  await expect(page.getByTestId("hints")).toHaveCount(0);
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
