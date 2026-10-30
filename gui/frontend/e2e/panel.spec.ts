import { expect, test, type Locator, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { emit, expectTooltip, invocations, mockUrl, openApp, openStreams, resetMock, row, threadPrompt } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

function box(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  });
}

async function selectThread(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

const panel = (page: Page) => page.getByTestId("side-panel");

/** data-region of the focused element ("panel", "content", ...). */
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
  await selectThread(page, "s-1");
  await expect(panel(page)).toHaveCount(0);
  const toggle = page.getByTestId("thread-header").getByTestId("panel-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expectTooltip(page, toggle, "Toggle Side Panel");

  await toggle.click();
  await expect(panel(page)).toBeVisible();
  // Open, the toggle moves to the panel's header (far right), out of the pane header.
  await expect(toggle).toHaveCount(0);
  const panelToggle = panel(page).getByTestId("panel-header").getByTestId("panel-toggle");
  await expect(panelToggle).toHaveAttribute("aria-pressed", "true");
  const empty = panel(page).getByTestId("panel-empty");
  await expect(empty.getByRole("heading", { name: "Open a surface" })).toBeVisible();
  // The built-in surfaces (the mock's hello plugin adds its demo below them: plugins.spec.ts).
  const entries = empty.locator('[data-surface]:not([data-surface^="plugin."])');
  // The thread's own surfaces are the thread info card's (docs/notes/thread-header-crumb.md):
  // Changes and MCP open from its rows, so the list has File, Diff and Pull request.
  await expect(entries).toHaveCount(3);
  await expect(entries).toHaveText(["FileF", "DiffD", "Pull requestP"]);
  for (const kind of ["files", "diff", "pullrequest"]) {
    await expect(empty.locator(`[data-surface="${kind}"]`)).toBeDisabled();
  }
  await expect(panel(page).getByTestId("panel-tabs")).toHaveCount(0);

  // Two panes, a shell gap (12px) apart, the panel 12px in from the window's right and bottom edges.
  const viewport = page.viewportSize();
  const content = await box(page, "content-pane");
  const side = await box(page, "side-panel");
  expect(side.left - content.right).toBe(12);
  expect(viewport && viewport.width - side.right).toBe(12);
  expect(viewport && viewport.height - side.bottom).toBe(12);
  expect(side.top).toBe(content.top);
  expect(side.width).toBe(420);
  // The panel header lines up with the content pane header: 44px, same top and bottom
  // (layout.spec.ts covers the band geometry and the other selection kinds).
  const header = await box(page, "panel-header");
  const threadHeader = await box(page, "thread-header");
  expect(header.bottom - header.top).toBe(44);
  expect([header.top, header.bottom]).toEqual([threadHeader.top, threadHeader.bottom]);

  await panelToggle.click();
  await expect(panel(page)).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("panel-resize-handle")).toHaveCount(0);
  expect(viewport && viewport.width - (await box(page, "content-pane")).right).toBe(12);
  // The button runs the registry command through its local presenter: no daemon call.
  expect((await invocations()).map((i) => i.name)).not.toContain("view.panel.toggle");
});

test("dragging the handle resizes the panel within its bounds, and the width persists", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
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
  // 360px: at 1280 with the 280px sidebar the room bound (1280-280-36-360) is the lower.
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no handle");
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(10, y, { steps: 4 });
  await page.mouse.up();
  const vw = page.viewportSize()?.width ?? 0;
  const max = Math.floor(Math.min(vw * 0.6, vw - 280 - 36 - 360));
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(max);
  expect((await box(page, "content-pane")).width).toBeGreaterThanOrEqual(360);
  await expect(handle).toHaveAttribute("aria-valuenow", String(max));
  await expect(handle).toHaveAttribute("aria-valuemax", String(max));

  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");

  // Each selection's panel has its own width: s-2's opens at the default, and sizing it
  // leaves s-1's alone.
  await selectThread(page, "s-2");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-2");
  expect((await box(page, "side-panel")).width).toBe(420);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(436);
  await selectThread(page, "s-1");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  expect((await box(page, "side-panel")).width).toBe(max);

  // Widths, open state, tabs and the active tab all survive a reload.
  await page.reload();
  await expect(row(page, "s:s-1")).toBeVisible();
  await selectThread(page, "s-1");
  await expect(panel(page)).toBeVisible();
  expect((await box(page, "side-panel")).width).toBe(max);
  await expect(panel(page).getByRole("tab")).toHaveText(["Files", "Diff"]);
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "diff");
  await selectThread(page, "s-2");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-2");
  expect((await box(page, "side-panel")).width).toBe(436);
  await expect(panel(page).getByTestId("panel-empty")).toBeVisible();

  // Double-click resets only that panel to the default.
  await selectThread(page, "s-1");
  await handle.dblclick();
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(420);
  await selectThread(page, "s-2");
  expect((await box(page, "side-panel")).width).toBe(436);
});

test("surface hotkeys do nothing while their surfaces are disabled", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
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

test("cmd+shift+e toggles the panel, even from the thread's prompt, and the daemon intent does too", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await threadPrompt(page).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("content");

  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("panel-empty")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveCount(0);
  // Hiding the focused panel hands focus back to the thread's prompt.
  await expect(threadPrompt(page)).toBeFocused();

  // The CLI path: view.panel.toggle emits ShowView "panel.toggle" to every window.
  expect(await emit({ showView: { name: "panel.toggle" } })).toBeGreaterThan(0);
  await expect(panel(page)).toBeVisible();

  // The settings sheet is a modal over the window: the panel stays laid out under it.
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(panel(page)).toBeVisible();
  // Escape outside the focused search field closes the sheet.
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
});

test("under the settings sheet the chord and the CLI still toggle the panel; the keyboard stays in the sheet", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  // The panel is on screen under the backdrop, so its toggles act on it, as under help.
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveCount(0);
  expect(await emit({ showView: { name: "panel.toggle" } })).toBeGreaterThan(0);
  await expect(panel(page)).toBeVisible();
  // Showing the panel from the keyboard asks for focus, but the modal keeps it.
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-sheet"]')))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  // Closing hands the keyboard to the thread's prompt, as after any settings close.
  await expect.poll(() => region(page)).toBe("content");
});

test("cmd+w in the focused empty panel is handled and hides the panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await recordCmdW(page);
  await page.getByTestId("panel-toggle").click();
  await expect.poll(() => region(page)).toBe("panel");
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => cmdW(page)).toEqual([true]);
  // Focus goes back to the thread's prompt.
  await expect.poll(() => region(page)).toBe("content");
});

test("tabs: cmd+w activates the neighbour, the × and middle click close, the last close hides", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  await injectTab(page, "pullrequest", "#12", { number: "12" });
  await injectTab(page, "pullrequest", "#13", { number: "13" });
  const tabs = panel(page).getByRole("tab");
  await expect(tabs).toHaveText(["Files", "Diff", "#12", "#13"]);
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "pullrequest?number=13");
  // The header drags the window from the strip's empty space, never from a tab or its ×.
  const dragOf = (sel: string) => panel(page).locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim());
  expect(await dragOf('[data-testid="panel-tabs"]')).toBe("drag");
  expect(await dragOf("[data-tab-id]")).toBe("no-drag");
  expect(await dragOf('[aria-label="Close Files"]')).toBe("no-drag");

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

  // Closing the last tab hides the panel and hands focus back to the thread.
  await tabs.first().click();
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");
});

test("tabs are keyboard reachable: arrows move, Enter activates, Tab reaches the ×", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
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

test("dragging starts from the rendered width after the room shrinks", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await dragHandle(page, -200);
  // At 1280 with the 280px sidebar the room bound is 604, so 420+200 clamps to it.
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(604);

  // The window shrinks: the panel renders at the room (1000-280-36-360 = 324) and keeps
  // the stored 604; a drag acts on the 324 at once.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(324);
  await dragHandle(page, 30);
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(294);
});

test("the palette hands focus back to the panel, and its toggle moves focus", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await expect.poll(() => region(page)).toBe("panel");

  // Open and dismiss the palette: focus returns to the panel.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("panel");

  // Hide the panel from the palette: focus goes to the thread's prompt.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Toggle Side Panel");
  await page.getByTestId("palette").locator('[data-command="view.panel.toggle"]').click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");

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

/** The thread pane's width (it narrows as the side panel widens; 0 while hidden). */
async function paneWidth(page: Page): Promise<number> {
  return (await box(page, "thread-pane")).width;
}

/** The icon the expand button shows: "maximize" or "minimize". */
function expandIcon(page: Page) {
  return panel(page)
    .getByTestId("panel-expand")
    .locator("svg")
    .evaluate((el) => (el.classList.contains("lucide-minimize-2") ? "minimize" : el.classList.contains("lucide-maximize-2") ? "maximize" : el.getAttribute("class")));
}

test("expand fills the content area, keeps the thread mounted, and restores the split", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  // Each step narrows the thread pane; wait for each, so `split` is the settled width.
  await expect.poll(() => paneWidth(page)).toBeGreaterThan(400);
  const full = await paneWidth(page);
  await page.getByTestId("panel-toggle").click();
  await expect.poll(() => paneWidth(page)).toBeLessThan(full);
  const at420 = await paneWidth(page);
  // A non-default width, to see it come back.
  await page.getByTestId("panel-resize-handle").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(436);
  await expect.poll(() => paneWidth(page)).toBeLessThan(at420);
  const split = await paneWidth(page);

  const expand = panel(page).getByTestId("panel-header").getByTestId("panel-expand");
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await expectTooltip(page, expand, "Expand Side Panel");
  expect(await expandIcon(page)).toBe("maximize");
  // Left of the toggle, and not a window drag surface.
  expect((await box(page, "panel-expand")).right).toBeLessThanOrEqual((await panel(page).getByTestId("panel-toggle").boundingBox())?.x ?? 0);
  expect(await expand.evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim())).toBe("no-drag");

  await expand.click();
  // The panel takes the content pane's place: 12px right of the sidebar, 12px in from the
  // window's right, top and bottom edges.
  const vp = page.viewportSize();
  const sidebar = await box(page, "sidebar");
  await expect.poll(async () => (await box(page, "side-panel-wrapper")).left).toBe(sidebar.right + 12);
  const wrapper = await box(page, "side-panel-wrapper");
  expect(vp && vp.width - wrapper.right).toBe(12);
  expect(wrapper.top).toBe(12);
  expect(vp && vp.height - wrapper.bottom).toBe(12);
  await expect(page.getByTestId("content-pane")).toBeHidden();
  // The content column (content pane and bottom panel) is display: none, not unmounted.
  expect(await page.getByTestId("content-column").evaluate((el) => getComputedStyle(el).display)).toBe("none");
  // The thread stays mounted and watched (its conversation and scroll position kept).
  await expect(page.getByTestId("thread-pane")).toHaveCount(1);
  await expect(page.getByTestId("thread-pane")).toBeHidden();
  expect((await openStreams())["ThreadService/WatchThread"]).toBe(1);
  await expect(page.getByTestId("panel-resize-handle")).toHaveCount(0);
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  expect(await expandIcon(page)).toBe("minimize");
  // The toggle stays in the panel's header.
  await expect(panel(page).getByTestId("panel-toggle")).toHaveAttribute("aria-pressed", "true");

  // Expanded, it shows even where a split panel would have no room.
  await setSidebarWidth(page, 520);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(async () => (await box(page, "side-panel-wrapper")).left).toBe(520 + 12);
  await expect(panel(page)).toBeVisible();
  await setSidebarWidth(page, 280);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Restoring brings the split back at the panel's width, and the thread at its width.
  await expand.click();
  await expect(page.getByTestId("content-pane")).toBeVisible();
  await expect.poll(async () => (await box(page, "side-panel")).width).toBe(436);
  await expect(page.getByTestId("panel-resize-handle")).toBeVisible();
  await expect.poll(() => paneWidth(page)).toBe(split);
  expect(await expandIcon(page)).toBe("maximize");
  // The button runs the command through its local presenter: no daemon call.
  expect((await invocations()).map((i) => i.name)).not.toContain("view.panel.expand");
});

test("expanded is per panel, survives a reload, and outlives hiding the panel", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await panel(page).getByTestId("panel-expand").click();
  await expect(page.getByTestId("content-pane")).toBeHidden();

  // s-2's panel is its own: hidden, then split when shown.
  await selectThread(page, "s-2");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("content-pane")).toBeVisible();
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-2");
  await expect(panel(page).getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("content-pane")).toBeVisible();
  expect((await box(page, "side-panel")).width).toBe(420);

  await row(page, "s:s-1").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await expect(page.getByTestId("content-pane")).toBeHidden();
  // Selecting a thread focuses its prompt; hidden, the panel takes that focus.
  await expect.poll(() => region(page)).toBe("panel");

  // Hiding keeps it expanded: showing it again comes back full width.
  await panel(page).getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("content-pane")).toBeVisible();
  await expect.poll(() => region(page)).toBe("content");
  await page.getByTestId("thread-header").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("content-pane")).toBeHidden();
  await expect(panel(page).getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(row(page, "s:s-1")).toBeVisible();
  await row(page, "s:s-1").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await expect(page.getByTestId("content-pane")).toBeHidden();
  await expect(panel(page).getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await selectThread(page, "s-2");
  await expect(panel(page).getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "false");
});

test("view.panel.expand from the palette and the CLI; focus follows the hidden thread", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await threadPrompt(page).click();
  await expect.poll(() => region(page)).toBe("content");

  // The palette: a hidden panel opens expanded, and the palette returns focus to it.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Expand Side Panel");
  await page.getByTestId("palette").locator('[data-command="view.panel.expand"]').click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("content-pane")).toBeHidden();
  await expect.poll(() => region(page)).toBe("panel");
  // Restoring from the palette leaves focus in the panel.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Expand Side Panel");
  await page.getByTestId("palette").locator('[data-command="view.panel.expand"]').click();
  await expect(page.getByTestId("content-pane")).toBeVisible();
  await expect.poll(() => region(page)).toBe("panel");

  // The CLI: CommandService.Invoke emits ShowView "panel.expand" to every window.
  await threadPrompt(page).click();
  await expect.poll(() => region(page)).toBe("content");
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "view.panel.expand" }),
  });
  expect(res.ok).toBe(true);
  await expect(page.getByTestId("content-pane")).toBeHidden();
  // The thread's prompt had focus and is hidden now: the panel takes it.
  await expect.poll(() => region(page)).toBe("panel");
  expect((await invocations()).map((i) => i.name)).toContain("view.panel.expand");

  // The settings sheet opens over the expanded panel, which stays as it is under it.
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("content-pane")).toBeHidden();
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("content-pane")).toBeHidden();
  await expect(panel(page).getByTestId("panel-expand")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => region(page)).toBe("panel");
});

test("the + after the last tab shows the surface list without adding a tab; picking, Escape and cmd+w leave it", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await recordCmdW(page);
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  const tabs = panel(page).getByRole("tab");
  const body = panel(page).getByTestId("panel-body");
  const empty = panel(page).getByTestId("panel-empty");
  const plus = panel(page).getByTestId("panel-tabs").getByTestId("panel-new-tab");
  await expect(tabs).toHaveText(["Files", "Diff"]);

  // Picking: the list shows, no tab is added, the panel has focus.
  await plus.click();
  await expect(panel(page)).toHaveAttribute("data-picking", "true");
  await expect(empty.getByRole("heading", { name: "Open a surface" })).toBeVisible();
  await expect(body).toHaveCount(0);
  await expect(tabs).toHaveText(["Files", "Diff"]);
  await expect.poll(() => region(page)).toBe("panel");
  // The + runs the registry command through its local presenter: no daemon call.
  expect((await invocations()).map((i) => i.name)).not.toContain("view.panel.new-tab");

  // Escape goes back to the tab that was active.
  await page.keyboard.press("Escape");
  await expect(panel(page)).not.toHaveAttribute("data-picking");
  await expect(body).toHaveAttribute("data-tab-id", "diff");

  // Picking a surface activates its tab (File brings back the panel's File tab).
  await plus.click();
  await empty.locator('[data-surface="files"]').click();
  await expect(tabs).toHaveText(["Files", "Diff"]);
  await expect(body).toHaveAttribute("data-surface", "files");
  await expect(panel(page)).not.toHaveAttribute("data-picking");

  // cmd+w goes back too (handled), instead of closing a tab or hiding the panel.
  await plus.click();
  await page.keyboard.press("Meta+w");
  await expect(body).toHaveAttribute("data-surface", "files");
  await expect(tabs).toHaveText(["Files", "Diff"]);
  await expect.poll(() => cmdW(page)).toEqual([true]);
});

test("closing the tab picking came from keeps picking; picking survives a reload", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  await injectTab(page, "pullrequest", "#12", { number: "12" });
  const tabs = panel(page).getByRole("tab");
  await tabs.filter({ hasText: "Diff" }).click();
  await panel(page).getByTestId("panel-new-tab").click();
  await panel(page).getByRole("button", { name: "Close Diff" }).click({ force: true });
  await expect(tabs).toHaveText(["Files", "#12"]);
  await expect(panel(page)).toHaveAttribute("data-picking", "true");

  await page.reload();
  await expect(row(page, "s:s-1")).toBeVisible();
  await row(page, "s:s-1").click();
  await expect(panel(page)).toHaveAttribute("data-picking", "true");
  await expect(panel(page).getByTestId("panel-new-tab")).toHaveAttribute("aria-pressed", "true");
  // Escape goes to the closed tab's right neighbour.
  await panel(page).focus();
  await page.keyboard.press("Escape");
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "pullrequest?number=12");
});

test("view.panel.new-tab from the palette and the CLI shows a hidden panel picking", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveCount(0);
  await threadPrompt(page).click();
  await expect.poll(() => region(page)).toBe("content");

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("New Side Panel Tab");
  await page.getByTestId("palette").locator('[data-command="view.panel.new-tab"]').click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(panel(page)).toHaveAttribute("data-picking", "true");
  await expect.poll(() => region(page)).toBe("panel");
  await page.keyboard.press("Escape");
  await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-tab-id", "files");

  // The CLI: CommandService.Invoke emits ShowView "panel.new-tab" to every window.
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "view.panel.new-tab" }),
  });
  expect(res.ok).toBe(true);
  await expect(panel(page)).toHaveAttribute("data-picking", "true");
  expect((await invocations()).map((i) => i.name)).toContain("view.panel.new-tab");
});

/**
 * Presses the mouse on a tab and moves it, in steps (past the 4px drag threshold), to
 * `x` on the tab's own row. The mouse stays down: `page.mouse.up()` drops it.
 */
async function startTabDrag(page: Page, tab: Locator, x: number): Promise<void> {
  const b = await tab.boundingBox();
  if (!b) throw new Error("no tab");
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + Math.min(12, b.width / 2), y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
}

/** The horizontal centre of an element, for a drop target. */
async function centerX(l: Locator): Promise<number> {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return b.x + b.width / 2;
}

test("dragging a tab onto its neighbour reorders the strip without activating it; the order survives a reload", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  await injectTab(page, "pullrequest", "#12", { number: "12" });
  const tabs = panel(page).getByRole("tab");
  const body = panel(page).getByTestId("panel-body");
  await expect(tabs).toHaveText(["Files", "Diff", "#12"]);

  // Mid-drag: the tab is lifted (and still never drags the window); its neighbour slid left.
  const diffLeft = await tabs.nth(1).evaluate((el) => (el.parentElement ?? el).getBoundingClientRect().left);
  await startTabDrag(page, tabs.first(), (await centerX(tabs.nth(1))) + 12);
  const lifted = panel(page).locator("[data-dragging]");
  await expect(lifted).toHaveAttribute("data-tab-id", "files");
  expect(await lifted.evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim())).toBe("no-drag");
  await expect.poll(() => tabs.nth(1).evaluate((el) => (el.parentElement ?? el).getBoundingClientRect().left)).toBeLessThan(diffLeft - 20);
  await page.mouse.up();
  await expect(tabs).toHaveText(["Diff", "Files", "#12"]);
  await expect(lifted).toHaveCount(0);
  // Dropping is not a click: the active tab stays.
  await expect(body).toHaveAttribute("data-tab-id", "pullrequest?number=12");
  await expect(tabs.filter({ hasText: "#12" })).toHaveAttribute("aria-selected", "true");

  // A plain click still activates (the sensor waits for 4px; the × and middle click are covered above).
  await tabs.filter({ hasText: "Files" }).click();
  await expect(body).toHaveAttribute("data-tab-id", "files");

  await page.reload();
  await expect(row(page, "s:s-1")).toBeVisible();
  await row(page, "s:s-1").click();
  await expect(tabs).toHaveText(["Diff", "Files", "#12"]);
  await expect(body).toHaveAttribute("data-tab-id", "files");
});

test("dropping a tab on the + puts it last, dragging back to the first tab puts it first; Escape mid-drag cancels, even while picking", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  await injectTab(page, "pullrequest", "#12", { number: "12" });
  const tabs = panel(page).getByRole("tab");
  const plus = panel(page).getByTestId("panel-new-tab");

  await startTabDrag(page, tabs.first(), await centerX(plus));
  await page.mouse.up();
  await expect(tabs).toHaveText(["Diff", "#12", "Files"]);
  // The + stays after the last tab.
  expect(await panel(page).getByTestId("panel-tabs").evaluate((el) => el.lastElementChild?.querySelector('[data-testid="panel-new-tab"]') !== null)).toBe(true);

  await startTabDrag(page, tabs.last(), await centerX(tabs.first()));
  await page.mouse.up();
  await expect(tabs).toHaveText(["Files", "Diff", "#12"]);

  // Escape mid-drag cancels: nothing moves. While picking (shown by the CLI's new-tab, not
  // the +: dnd-kit swallows clicks for 50ms after a drop) it belongs to the drag, so the
  // surface list stays; once the drag is over, Escape is the panel's again.
  expect(await emit({ showView: { name: "panel.new-tab" } })).toBeGreaterThan(0);
  await expect(panel(page)).toHaveAttribute("data-picking", "true");
  await startTabDrag(page, tabs.first(), await centerX(plus));
  await expect(panel(page).locator("[data-dragging]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(tabs).toHaveText(["Files", "Diff", "#12"]);
  await expect(panel(page)).toHaveAttribute("data-picking", "true");
  await page.keyboard.press("Escape");
  await expect(panel(page)).not.toHaveAttribute("data-picking");
});

test("the drop settle leaves no transform or animation behind, and a tab picked up again mid-settle follows the pointer", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  await injectTab(page, "files", "Files");
  await injectTab(page, "diff", "Diff");
  await injectTab(page, "pullrequest", "#12", { number: "12" });
  const tabs = panel(page).getByRole("tab");
  const plus = panel(page).getByTestId("panel-new-tab");
  const strip = panel(page).getByTestId("panel-tabs");
  const residue = () =>
    strip.evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>("[data-tab-id]"))
        .filter((w) => w.getAnimations().length > 0 || getComputedStyle(w).transform !== "none")
        .map((w) => w.dataset.tabId),
    );

  // A drop, then the same tab picked up again at once: the lifted tab (the ghost, since
  // split 3) is under the pointer, and its slot has no animation but its CSS slide.
  await startTabDrag(page, tabs.first(), await centerX(plus));
  await page.mouse.up();
  await expect(tabs).toHaveText(["Diff", "#12", "Files"]);
  const files = panel(page).locator('[data-tab-id="files"]');
  const to = await centerX(tabs.first());
  await startTabDrag(page, tabs.last(), to);
  await expect(panel(page).locator("[data-dragging]")).toHaveAttribute("data-tab-id", "files");
  expect(await files.evaluate((el) => el.getAnimations().filter((a) => !("transitionProperty" in a)).length)).toBe(0);
  // The first ghost: the drop's ghost may still be flying to its slot (dnd-kit renders the new one first).
  const ghost = await page.getByTestId("panel-tab-ghost").first().boundingBox();
  expect(ghost && ghost.x <= to && to <= ghost.x + ghost.width).toBe(true);
  await page.mouse.up();
  await expect(tabs).toHaveText(["Files", "Diff", "#12"]);
  await expect.poll(residue).toEqual([]);

  // A cancel settles the same way.
  await startTabDrag(page, tabs.first(), await centerX(plus));
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(tabs).toHaveText(["Files", "Diff", "#12"]);
  await expect.poll(residue).toEqual([]);
});

test("dragging a tab to the strip's edge scrolls the strip and lands it at the far end; alt+Right past the edge scrolls too", async ({ page }) => {
  await openApp(page);
  await selectThread(page, "s-1");
  await page.getByTestId("panel-toggle").click();
  for (let n = 1; n <= 12; n++) await injectTab(page, "pullrequest", `#${String(n)} tab`, { number: String(n) });
  const tabs = panel(page).getByRole("tab");
  const strip = panel(page).getByTestId("panel-tabs");
  await expect(tabs).toHaveCount(12);
  const scroll = () => strip.evaluate((el) => ({ left: Math.round(el.scrollLeft), max: el.scrollWidth - el.clientWidth }));
  expect((await scroll()).max).toBeGreaterThan(200);

  // To the right: from the start, hold the dragged first tab at the right edge.
  await strip.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const s = await strip.boundingBox();
  if (!s) throw new Error("no strip");
  await startTabDrag(page, tabs.first(), s.x + s.width - 6);
  await expect.poll(async () => (await scroll()).left, { timeout: 8_000 }).toBe((await scroll()).max);
  await page.mouse.up();
  await expect(tabs.last()).toHaveText("#1 tab");
  await expect(tabs.first()).toHaveText("#2 tab");

  // And back to the left edge: the last tab lands first.
  await startTabDrag(page, tabs.last(), s.x + 6);
  await expect.poll(async () => (await scroll()).left, { timeout: 8_000 }).toBe(0);
  await page.mouse.up();
  await expect(tabs.first()).toHaveText("#1 tab");
  await expect(tabs.nth(1)).toHaveText("#2 tab");

  // alt+Right on the last fully visible tab moves it past the edge: the strip follows it.
  await strip.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const edge = await strip.evaluate((el) => {
    const right = el.getBoundingClientRect().right;
    const wrappers = Array.from(el.querySelectorAll<HTMLElement>("[data-tab-id]"));
    const last = wrappers.filter((w) => w.getBoundingClientRect().right <= right).pop();
    last?.querySelector<HTMLElement>('[role="tab"]')?.focus({ preventScroll: true });
    return last?.dataset.tabId ?? "";
  });
  expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.keyboard.press("Alt+ArrowRight");
  const moved = strip.locator(`[data-tab-id="${edge}"]`);
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  const [m, sb] = await Promise.all([moved.boundingBox(), strip.boundingBox()]);
  expect(m && sb && m.x + m.width <= sb.x + sb.width + 1).toBe(true);
  await expect(moved.getByRole("tab")).toBeFocused();
});

/** SHOTS=<dir>: docs/notes/panel-tab-reorder screenshots, mid-drag, WebKit, 1400x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`tab reorder screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await selectThread(page, "s-1");
    await page.getByTestId("panel-toggle").click();
    await injectTab(page, "files", "Files");
    await injectTab(page, "diff", "Diff");
    await injectTab(page, "pullrequest", "#12", { number: "12" });
    const tabs = panel(page).getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await tabs.first().click();
    await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-surface", "files");

    // Lift Diff and hold it just past the first slot: the Files tab has slid right to make room.
    const first = await tabs.first().boundingBox();
    await startTabDrag(page, tabs.nth(1), (first?.x ?? 0) + 22);
    await expect(panel(page).locator("[data-dragging]")).toHaveCount(1);
    await page.waitForTimeout(400); // the neighbour's 200ms slide
    await page.screenshot({ path: `${shots ?? ""}/panel-tab-reorder-drag${suffix}.png` });
    const header = await box(page, "panel-header");
    await page.screenshot({ path: `${shots ?? ""}/panel-tab-reorder-drag-closeup${suffix}.png`, clip: { x: header.left, y: header.top, width: header.right - header.left, height: header.bottom - header.top + 120 } });
    await page.mouse.up();
    await expect(tabs.first()).toHaveText("Diff");
  });
}

/** SHOTS=<dir>: docs/notes/panel-new-tab screenshots, WebKit, 1400x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`new-tab screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    const shot = (name: string) => page.screenshot({ path: `${String(shots)}/${name}${suffix}.png` });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await selectThread(page, "s-1");
    await page.getByTestId("panel-toggle").click();
    await injectTab(page, "files", "Files");
    await injectTab(page, "diff", "Diff");
    await expect(panel(page).getByRole("tab")).toHaveCount(2);
    await panel(page).getByRole("tab").first().click();
    await expect(panel(page).getByTestId("panel-body")).toHaveAttribute("data-surface", "files");
    await page.mouse.move(0, 0);
    await shot("panel-new-tab-strip");

    await panel(page).getByTestId("panel-new-tab").click();
    await expect(panel(page)).toHaveAttribute("data-picking", "true");
    await page.mouse.move(0, 0);
    await shot("panel-new-tab-picking");
  });
}
