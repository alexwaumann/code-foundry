import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  });
}

async function selectSession(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
}

const panel = (page: Page) => page.getByTestId("side-panel");

test("the header toggle shows the empty surface list and hides the panel again", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await expect(panel(page)).toHaveCount(0);
  const toggle = page.getByTestId("terminal-header").getByTestId("panel-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAttribute("title", "Toggle Side Panel");

  await toggle.click();
  await expect(panel(page)).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const empty = panel(page).getByTestId("panel-empty");
  await expect(empty.getByRole("heading", { name: "Open a surface" })).toBeVisible();
  const entries = empty.locator("[data-surface]");
  await expect(entries).toHaveCount(3);
  await expect(entries).toHaveText(["FilesF", "DiffD", "Pull requestP"]);
  for (const kind of ["files", "diff", "pullrequest"]) {
    await expect(empty.locator(`[data-surface="${kind}"]`)).toBeDisabled();
  }
  await expect(panel(page).getByTestId("panel-tabs")).toHaveCount(0);

  // Two panes, 8px apart, the panel 8px in from the window's right and bottom edges.
  const viewport = page.viewportSize();
  const content = await box(page, "content-pane");
  const side = await box(page, "side-panel");
  expect(side.left - content.right).toBe(8);
  expect(viewport && viewport.width - side.right).toBe(8);
  expect(viewport && viewport.height - side.bottom).toBe(8);
  expect(side.top).toBe(content.top);
  expect(side.width).toBe(420);

  await toggle.click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("panel-resize-handle")).toHaveCount(0);
  expect(viewport && viewport.width - (await box(page, "content-pane")).right).toBe(8);
  // The button runs the registry command through its local presenter: no daemon call.
  expect((await invocations()).map((i) => i.name)).not.toContain("view.panel.toggle");
});

test("dragging the handle resizes the panel within its bounds, and the width persists", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  const handle = page.getByTestId("panel-resize-handle");
  const before = (await box(page, "side-panel")).width;
  const h = await handle.boundingBox();
  if (!h) throw new Error("no handle");
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(before + 120);

  // Not narrower than 280px.
  await page.mouse.move(x - 120, y);
  await page.mouse.down();
  await page.mouse.move(x + 600, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(280);

  // Not wider than 60% of the window.
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no handle");
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(10, y, { steps: 4 });
  await page.mouse.up();
  const max = Math.floor((page.viewportSize()?.width ?? 0) * 0.6);
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(max);

  // The width is saved; open/tabs are not (the panel starts hidden after a reload).
  await page.reload();
  await expect(row(page, "s:s-1")).toBeVisible();
  await selectSession(page, "s-1");
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId("panel-toggle").click();
  expect((await box(page, "side-panel")).width).toBe(max);
});

test("surface hotkeys do nothing while their surfaces are disabled", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  // Opening the panel moves focus into it, so its hotkeys apply.
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("panel");
  for (const key of ["f", "d", "p", "Meta+w"]) await page.keyboard.press(key);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("panel-empty")).toBeVisible();
  await expect(panel(page).getByTestId("panel-tabs")).toHaveCount(0);
  // Clicking a disabled entry does nothing either.
  await panel(page).locator('[data-surface="files"]').click({ force: true });
  await expect(panel(page).getByTestId("panel-tabs")).toHaveCount(0);
});

test("each session has its own panel state", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-1");

  await selectSession(page, "s-2");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("panel-toggle")).toHaveAttribute("aria-pressed", "false");

  await selectSession(page, "s-1");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-1");

  // Hiding it on s-1 leaves s-2's (still hidden) alone, and vice versa.
  await selectSession(page, "s-2");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-2");
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveCount(0);
  await selectSession(page, "s-2");
  await expect(panel(page)).toBeVisible();
});

test("cmd+shift+e toggles the panel, even from the terminal, and the daemon intent does too", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("terminal-host").click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("terminal");

  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("panel-empty")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveCount(0);
  // Hiding the focused panel hands focus back to the terminal.
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("terminal");

  // The CLI path: view.panel.toggle emits ShowView "panel.toggle" to every window.
  expect(await emit({ showView: { name: "panel.toggle" } })).toBeGreaterThan(0);
  await expect(panel(page)).toBeVisible();

  // The settings page covers the panel; closing it brings the panel back.
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  // Escape outside the focused search field closes the page.
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
});

test("worktrees and the Pull Requests page have their own panels and toggles", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.getByTestId("prs-page")).toBeVisible();
  await page.getByTestId("prs-page").getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "view:pullrequests");

  await row(page, "s:s-3").click();
  await expect(page.getByTestId("session-disconnected")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId("session-disconnected").getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-3");
});
