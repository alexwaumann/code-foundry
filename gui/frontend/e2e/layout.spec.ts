import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";
import { openShellApp, paneNode, rowNode, seedLayout, threadTab } from "./shell";

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

// The window's geometry around the panes: the sidebar's width, its status row on the panes'
// bottom edge, and the colours of the sheet, the panes and a terminal in one. The top bar (the
// window's drag band, its gutter and history buttons) and the pane grid are the shell-*.spec.ts
// files' (shell-spaces, shell-grid).
const GAP = 12;

test("the sidebar starts at 240 (the top bar's toggle), a width saved by an older build resets once, and a dragged width is kept", async ({ page }) => {
  const width = async () => (await box(page, "sidebar")).width;
  // A store saved before version 4, at the old 280 default dragged to 360.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("code-foundry.ui", JSON.stringify({ state: { sidebarWidth: 360, workingCollapsed: true }, version: 3 }));
  });
  await openApp(page);
  await expect.poll(width).toBe(240);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("code-foundry.ui") ?? "{}") as unknown)).toMatchObject({ state: { sidebarWidth: 240, workingCollapsed: true }, version: 4 });

  // Dragging the handle: the width persists across a reload, capped at the maximum.
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no handle");
  const y = hb.y + hb.height / 2;
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 110, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBe(350);
  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await expect.poll(width).toBe(350);
  await page.mouse.move(350 + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(1200, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBe(520);
  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await expect.poll(width).toBe(520);

  // Double-click restores the 240 default.
  await handle.dblclick();
  await expect.poll(width).toBe(240);
});

/** SHOTS=<dir>: the PR's screenshots of the 240px default, WebKit, 1280x800, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`sidebar default screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await expect.poll(async () => (await box(page, "sidebar")).width).toBe(240);
    await page.mouse.move(640, 400);
    await page.screenshot({ path: `${String(shots)}/sidebar-240-${scheme}.png` });
  });
}

test("the daemon status sits at the bottom of the sidebar, its glyphs on the pane's bottom edge", async ({ page }) => {
  await seedLayout(paneNode("p-1", [threadTab("s-3")]), "p-1");
  await openShellApp(page);
  const sidebar = await box(page, "sidebar");
  const status = await box(page, "daemon-status");
  expect(status.left).toBeGreaterThanOrEqual(sidebar.left);
  expect(status.right).toBeLessThanOrEqual(sidebar.right);
  // The row (24px) ends 7px above the window's bottom edge, so its 14px glyphs (centred in
  // 24px boxes) end on the panes' bottom edge, a shell gap (12px) up.
  const pane = await box(page, "shell-pane");
  expect((page.viewportSize()?.height ?? 0) - pane.bottom).toBe(GAP);
  const settings = await box(page, "status-settings");
  expect(settings.bottom - 5).toBe(pane.bottom);
  await expect(page.locator("footer")).toHaveCount(0);

  // The row shows the dot and version only; the daemon's pid and uptime are its tooltip.
  const daemon = page.getByTestId("daemon-status");
  await expect(daemon).toHaveText("mock");
  await daemon.hover();
  const tip = page.locator('[role="tooltip"]:not([data-state="closed"])');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/^daemon · pid \d+ · up /);
});

// Dark only: the per-scheme palette is src/terminal/theme.test.ts.
test("sidebar sits on the sheet and a terminal tab's terminal matches its pane", async ({ page }) => {
  // s-1's shell in a terminal tab beside its thread.
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [{ id: "t-sh", kind: "terminal", thread: "s-1", params: { terminal: "t-s1-shell" } }])]), "p-2");
  await openShellApp(page);
  const sheet = await bg(page, "body");
  expect(await bg(page, '[data-testid="sidebar"]')).toBe(sheet);
  const pane = await bg(page, '[data-testid="shell-pane"]');
  expect(pane).not.toBe(sheet);
  expect(await page.getByTestId("sidebar").evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("0px");

  // The xterm theme background (src/terminal/theme.ts) must be the pane colour.
  await expect(page.getByTestId("shell-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  expect(await bg(page, '[data-testid="shell-pane"]:has([data-testid="shell-terminal"])')).toBe(pane);
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
  expect(await bg(page, '[data-testid="shell-terminal-host"] >> xpath=..')).toBe(pane);
});
