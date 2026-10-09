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

/** data-region of the focused element ("panel", "terminal", "content", ...). */
function region(page: Page) {
  return page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") ?? null);
}

/**
 * Opens a tab in the current selection's panel through the app's own panel store (Vite
 * serves the module, so the import reaches the instance the app uses).
 */
async function injectTab(page: Page, kind: string, title: string, params: Record<string, string> = {}): Promise<void> {
  const args = [kind, title, params].map((a) => JSON.stringify(a)).join(", ");
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.openSurface("current", m.makeTab(${args})))`);
}

/** Sets the sidebar width through the app's own ui store (as dragging its handle would). */
async function setSidebarWidth(page: Page, w: number): Promise<void> {
  await page.evaluate(`import("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setSidebarWidth(${String(w)}))`);
}

/** Records, for every cmd+w keydown, whether something called preventDefault on it. */
async function recordCmdW(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cmdw: boolean[] };
    w.__cmdw = [];
    // Capture phase, read after dispatch: the panel stops propagation, so a bubbling
    // listener on window would never see the event.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.metaKey && e.key.toLowerCase() === "w") {
          setTimeout(() => {
            w.__cmdw.push(e.defaultPrevented);
          }, 0);
        }
      },
      true,
    );
  });
}

function cmdW(page: Page): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __cmdw: boolean[] }).__cmdw);
}

async function dragHandle(page: Page, dx: number): Promise<void> {
  const h = await page.getByTestId("panel-resize-handle").boundingBox();
  if (!h) throw new Error("no handle");
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

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

  // Not wider than 60% of the window, nor so wide that the content pane gets under
  // 360px: at 1280 with the 260px sidebar the room bound (1280-260-24-360) is the lower.
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no handle");
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(10, y, { steps: 4 });
  await page.mouse.up();
  const vw = page.viewportSize()?.width ?? 0;
  const max = Math.floor(Math.min(vw * 0.6, vw - 260 - 24 - 360));
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(max);
  expect((await box(page, "content-pane")).width).toBeGreaterThanOrEqual(360);
  await expect(handle).toHaveAttribute("aria-valuenow", String(max));
  await expect(handle).toHaveAttribute("aria-valuemax", String(max));

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
  await expect.poll(() => region(page)).toBe("panel");
  for (const key of ["f", "d", "p"]) await page.keyboard.press(key);
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

test("toggling while the settings page is up does nothing", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  // Neither the chord nor the CLI flips the hidden panel's state.
  await page.keyboard.press("Meta+Shift+e");
  expect(await emit({ showView: { name: "panel.toggle" } })).toBeGreaterThan(0);
  // Emit returns once the intent is queued. A Notify behind it on the same stream shows
  // when the toggle has been handled, so it cannot land after settings closes.
  expect(await emit({ notify: { level: "LEVEL_INFO", title: "after-toggle", body: "" } })).toBeGreaterThan(0);
  await expect(page.getByText("after-toggle")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  // No focus request was left pending for it: the terminal has focus, as after any settings close.
  await expect.poll(() => region(page)).toBe("terminal");
});

test("cmd+w in the focused empty panel is handled and hides the panel", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await recordCmdW(page);
  await page.getByTestId("panel-toggle").click();
  await expect.poll(() => region(page)).toBe("panel");
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => cmdW(page)).toEqual([true]);
  // Focus goes back to the content pane's terminal.
  await expect.poll(() => region(page)).toBe("terminal");
});

test("tabs: cmd+w activates the neighbour, the × and middle click close, the last close hides", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  await injectTab(page, "pullrequest", "#12", { number: "12" });
  await injectTab(page, "pullrequest", "#13", { number: "13" });
  const tabs = panel(page).getByRole("tab");
  await expect(tabs).toHaveText(["Files", "Diff", "#12", "#13"]);
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "pullrequest?number=13");

  // cmd+w closes the active (last) tab; its left neighbour becomes active.
  await tabs.filter({ hasText: "Diff" }).click();
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "diff");
  await page.keyboard.press("Meta+w");
  await expect(tabs).toHaveText(["Files", "#12", "#13"]);
  // The right neighbour wins when there is one.
  await expect(tabs.filter({ hasText: "#12" })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "pullrequest?number=12");

  // The × on a tab closes it.
  await panel(page).getByRole("button", { name: "Close #13" }).click({ force: true });
  await expect(tabs).toHaveText(["Files", "#12"]);
  // Middle click closes too.
  await tabs.filter({ hasText: "Files" }).click({ button: "middle" });
  await expect(tabs).toHaveText(["#12"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  // Closing the last tab hides the panel and hands focus back to the terminal.
  await tabs.first().click();
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("terminal");
});

test("tabs are keyboard reachable: arrows move, Enter activates, Tab reaches the ×", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  const tabs = panel(page).getByRole("tab");
  await expect(panel(page).getByRole("tablist")).toBeVisible();
  // Only the active tab is in the tab order.
  await expect(tabs.filter({ hasText: "Diff" })).toHaveAttribute("tabindex", "0");
  await expect(tabs.filter({ hasText: "Files" })).toHaveAttribute("tabindex", "-1");

  await tabs.filter({ hasText: "Diff" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.filter({ hasText: "Files" })).toBeFocused();
  // Moving focus does not activate; Enter does.
  await expect(tabs.filter({ hasText: "Diff" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(tabs.filter({ hasText: "Files" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tabs.filter({ hasText: "Diff" })).toBeFocused();
  await page.keyboard.press(" ");
  await expect(tabs.filter({ hasText: "Diff" })).toHaveAttribute("aria-selected", "true");

  // The active tab's close button is next in the tab order.
  await page.keyboard.press("Tab");
  await expect(panel(page).getByRole("button", { name: "Close Diff" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs).toHaveText(["Files"]);
});

test("the resize separator is keyboard operable", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  const handle = page.getByTestId("panel-resize-handle");
  await expect(handle).toHaveAttribute("aria-valuenow", "420");
  await expect(handle).toHaveAttribute("aria-valuemin", "280");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "436");
  expect((await box(page, "side-panel")).width).toBe(436);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "372");
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "280");
});

test("a narrow window with a wide sidebar shrinks the panel, then hides it, never squeezing the content pane", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await setSidebarWidth(page, 520);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toBeVisible();
  // 1200 - 520 sidebar - 24 gaps - 360 content minimum.
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(296);
  expect((await box(page, "content-pane")).width).toBeGreaterThanOrEqual(360);
  expect((await box(page, "side-panel")).right).toBe(1200 - 8);

  // No room for 280px: the panel hides but stays open, and the content pane fills the row.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("panel-toggle")).toHaveAttribute("aria-pressed", "true");
  expect((await box(page, "content-pane")).right).toBe(1000 - 8);

  // Hiding the sidebar makes room again.
  await page.getByTestId("terminal-host").click();
  await page.keyboard.press("Meta+b");
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await box(page, "side-panel")).right).toBe(1000 - 8);
  expect((await box(page, "content-pane")).width).toBeGreaterThanOrEqual(360);
});

test("dragging starts from the rendered width after the room shrinks", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await dragHandle(page, -200);
  // At 1280 with the 260px sidebar the room bound is 636.
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(620);

  // The window shrinks: the stored width is re-clamped (1000-260-24-360 = 356).
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(356);
  await dragHandle(page, 30);
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(326);

  // A wider sidebar shrinks the rendered width below the stored one; a drag acts at once.
  await page.setViewportSize({ width: 1280, height: 800 });
  await setSidebarWidth(page, 480);
  // 1280-480-24-360 = 416 is the room; the stored 326 fits. Widen to the room.
  await dragHandle(page, -200);
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(416);
  await setSidebarWidth(page, 520);
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(376);
  await dragHandle(page, 20);
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(356);
});

test("the palette hands focus back to the panel, and its toggle moves focus", async ({ page }) => {
  await openApp(page);
  await selectSession(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await expect.poll(() => region(page)).toBe("panel");

  // Open and dismiss the palette: focus returns to the panel.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("panel");

  // Hide the panel from the palette: focus goes to the content pane's terminal.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Toggle Side Panel");
  await page.getByTestId("palette").locator('[data-command="view.panel.toggle"]').click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("terminal");

  // Show it from the palette: focus goes to the panel.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Toggle Side Panel");
  await page.getByTestId("palette").locator('[data-command="view.panel.toggle"]').click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => region(page)).toBe("panel");
});

test("closing the last tab on the Pull Requests page focuses the page's list", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.getByTestId("prs-list")).toBeFocused();
  await page.getByTestId("prs-page").getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await panel(page).getByRole("tab").first().click();
  await expect.poll(() => region(page)).toBe("panel");
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("prs-list")).toBeFocused();
  // Its keys work at once.
  await page.keyboard.press("j");
  await expect(page.getByTestId("prs-list").locator('[aria-selected="true"]')).toHaveCount(1);
});

test("hiding the focused panel on a disconnected session focuses the page", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await expect(page.getByTestId("session-disconnected")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect.poll(() => region(page)).toBe("panel");
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("session-disconnected")).toBeFocused();
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
