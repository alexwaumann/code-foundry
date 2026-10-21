// Side panel split, PR 3 (docs/notes/panel-split-3-drag.md): dragging a tab between the
// groups, onto the other group's body, and onto an unsplit panel's drop band to split it.
// Every test here fails without the feature: each strip had its own DndContext, so a tab
// could only reorder within its strip, and there was no band, ghost, marker or tint.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await resetMock();
  // Wide enough for a 760px panel beside the sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
});

const panel = (page: Page) => page.getByTestId("side-panel");
const split = (page: Page) => page.getByTestId("panel-split");
const group = (page: Page, g: 0 | 1) => panel(page).locator(`[data-panel-group="${String(g)}"]`);
const tabsOf = (page: Page, g: 0 | 1) => group(page, g).getByRole("tab");
const tabIn = (page: Page, g: 0 | 1, title: string) => tabsOf(page, g).filter({ hasText: title });
const bodyOf = (page: Page, g: 0 | 1) => group(page, g).getByTestId("panel-body");
const band = (page: Page) => panel(page).getByTestId("panel-drop-band");
const ghost = (page: Page) => page.getByTestId("panel-tab-ghost");

async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(width)}))`);
}

/** Calls a function of the app's own panel store with JSON arguments. */
async function store(page: Page, fn: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.${fn}(${args.map((a) => JSON.stringify(a)).join(", ")}))`);
}

/** The current panel's groups, as tab ids, and the focused group. */
function groups(page: Page): Promise<{ tabs: string[]; active: string | null }[]> {
  return page.evaluate(`import("/src/stores/panel.ts").then((m) => m.getPanel("current").groups.map((g) => ({ tabs: g.tabs.map((t) => t.id), active: g.activeTabId })))`);
}

function rect(l: Locator) {
  return l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
}

/** s-1's panel at `width` with the given tabs (kind, title, params) opened in order, the first one active. */
async function panelWith(page: Page, width: number, tabs: [string, string, Record<string, string>?][]): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await setPanelWidth(page, width);
  for (const [kind, title, params] of tabs) {
    await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.openSurface("current", m.makeTab(${JSON.stringify(kind)}, ${JSON.stringify(title)}, ${JSON.stringify(params ?? {})})))`);
  }
  await expect(panel(page).getByRole("tab")).toHaveCount(tabs.length);
  await store(page, "activatePanelTab", "current", tabs[0]?.[0] ?? "");
}

const THREE: [string, string, Record<string, string>?][] = [
  ["files", "Files"],
  ["diff", "Diff"],
  ["pullrequest", "#12", { number: "12" }],
];

/**
 * Presses the mouse on a tab and moves it, in steps (past the 4px drag threshold), to
 * (x, y). The mouse stays down: `page.mouse.up()` drops it. It first waits for the
 * panel's animations to end: after a drop the tabs slide into their new slots for 200ms,
 * and a tab pressed mid-slide is lifted from its final slot, not where it was seen.
 */
async function startDrag(page: Page, tab: Locator, x: number, y: number): Promise<void> {
  await expect.poll(() => panel(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  const b = await tab.boundingBox();
  if (!b) throw new Error("no tab");
  await page.mouse.move(b.x + Math.min(12, b.width / 2), b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
}

/** A point at fractions (fx, fy) of an element's box. */
async function at(l: Locator, fx: number, fy: number): Promise<[number, number]> {
  const r = await rect(l);
  return [r.left + r.width * fx, r.top + r.height * fy];
}

test("dropping a tab on the band splits the panel with it in the second group: the bottom band stacked, the right band side by side", async ({ page }) => {
  await panelWith(page, 420, THREE);
  await expect(split(page)).not.toHaveAttribute("data-split");
  const body = bodyOf(page, 0);
  const b = await rect(body);

  // Stacked (420px): the band is the bottom 45% of the body, 8px in from its edges.
  await startDrag(page, tabIn(page, 0, "Diff"), ...(await at(body, 0.5, 0.8)));
  await expect(band(page)).toHaveAttribute("data-side", "stack");
  await expect(band(page)).toHaveAttribute("data-over", "true");
  const r = await rect(band(page));
  expect(Math.abs(r.left - (b.left + 8))).toBeLessThan(1);
  expect(Math.abs(r.right - (b.right - 8))).toBeLessThan(1);
  expect(Math.abs(r.bottom - (b.bottom - 8))).toBeLessThan(1);
  expect(Math.abs(r.top - (b.top + b.height * 0.55))).toBeLessThan(1);
  // The lifted tab is the ghost under the pointer; its slot stays, dimmed.
  await expect(ghost(page)).toHaveText("Diff");
  // It never takes the pointer (after a drop it flies over the tabs).
  expect(await ghost(page).evaluate((el) => getComputedStyle(el.parentElement ?? el).pointerEvents)).toBe("none");
  const slot = panel(page).locator("[data-dragging]");
  await expect(slot).toHaveAttribute("data-tab-id", "diff");
  expect(await slot.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.4");
  await page.mouse.up();

  await expect(split(page)).toHaveAttribute("data-split", "true");
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await expect(tabsOf(page, 0)).toHaveText(["Files", "#12"]);
  await expect(tabsOf(page, 1)).toHaveText(["Diff"]);
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(bodyOf(page, 1)).toHaveAttribute("data-tab-id", "diff");
  await expect(band(page)).toHaveCount(0);
  await expect(ghost(page)).toHaveCount(0);

  // Side by side (760px): the band is the right 45%.
  await store(page, "unsplitPanel", "current");
  await expect(split(page)).not.toHaveAttribute("data-split");
  await setPanelWidth(page, 760);
  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(body, 0.85, 0.5)));
  await expect(band(page)).toHaveAttribute("data-side", "side");
  await expect(band(page)).toHaveAttribute("data-over", "true");
  const [b2, r2] = await Promise.all([rect(body), rect(band(page))]);
  expect(Math.abs(r2.left - (b2.left + b2.width * 0.55))).toBeLessThan(1);
  expect(Math.abs(r2.right - (b2.right - 8))).toBeLessThan(1);
  expect(Math.abs(r2.top - (b2.top + 8))).toBeLessThan(1);
  await page.mouse.up();
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
  await expect(tabsOf(page, 1)).toHaveText(["Files"]);
  expect((await groups(page)).map((g) => g.tabs)).toEqual([["pullrequest?number=12", "diff"], ["files"]]);
});

test("the band's edge follows the threshold, and an expanded panel's real width: bottom in a narrow window, right in a wide one", async ({ page }) => {
  await panelWith(page, 720, THREE);
  const body = bodyOf(page, 0);
  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(body, 0.5, 0.5)));
  await expect(band(page)).toHaveAttribute("data-side", "stack");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await setPanelWidth(page, 721);
  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(body, 0.5, 0.5)));
  await expect(band(page)).toHaveAttribute("data-side", "side");
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // Expanded in a 900px window the panel renders under 721px: the bottom band, and the drop stacks.
  await store(page, "setPanelWidth", "current", 760);
  await store(page, "expandPanel", "current", true);
  await expect(page.getByTestId("side-panel-wrapper")).toHaveAttribute("data-expanded", "true");
  await page.setViewportSize({ width: 900, height: 900 });
  await startDrag(page, tabIn(page, 0, "Diff"), ...(await at(body, 0.5, 0.85)));
  await expect(band(page)).toHaveAttribute("data-side", "stack");
  await expect(band(page)).toHaveAttribute("data-over", "true");
  await page.mouse.up();
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");
  await expect(tabsOf(page, 1)).toHaveText(["Diff"]);
  // Widened, the same expanded panel goes side by side.
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(split(page)).toHaveAttribute("data-orientation", "side");
});

test("a single-tab panel shows no band; a drop on the body outside the band, or Escape, puts the tab back", async ({ page }) => {
  await panelWith(page, 420, [["files", "Files"]]);
  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(bodyOf(page, 0), 0.5, 0.8)));
  await expect(ghost(page)).toBeVisible();
  await expect(panel(page).locator("[data-dragging]")).toHaveCount(1);
  await expect(band(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(tabsOf(page, 0)).toHaveText(["Files"]);

  // Two tabs: the band shows, faint, while the pointer is elsewhere; a drop there changes nothing.
  await store(page, "openSurface", "current", { id: "diff", kind: "diff", title: "Diff", params: {} });
  await expect(tabsOf(page, 0)).toHaveText(["Files", "Diff"]);
  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(bodyOf(page, 0), 0.5, 0.25)));
  await expect(band(page)).toBeVisible();
  await expect(band(page)).not.toHaveAttribute("data-over");
  await page.mouse.up();
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(tabsOf(page, 0)).toHaveText(["Files", "Diff"]);

  // Escape over the band cancels. The tab is picked up again at once, while the last
  // drop's ghost still flies back over it: the ghost never takes the pointer.
  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(bodyOf(page, 0), 0.5, 0.8)));
  await expect(band(page)).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(tabsOf(page, 0)).toHaveText(["Files", "Diff"]);
});

test("a tab dragged onto the other strip lands at the slot under the pointer; within a strip it still reorders; alt+arrows stay in the group", async ({ page }) => {
  await panelWith(page, 760, THREE);
  await store(page, "movePanelTabToGroup", "current", "diff", 1);
  await expect(tabsOf(page, 0)).toHaveText(["Files", "#12"]);
  await expect(tabsOf(page, 1)).toHaveText(["Diff"]);

  // Files, onto group 1's strip just left of Diff's centre: the marker sits before Diff, and the drop puts Files there.
  const diff = await rect(tabIn(page, 1, "Diff"));
  await startDrag(page, tabIn(page, 0, "Files"), diff.left + 4, diff.top + diff.height / 2);
  const marker = group(page, 1).getByTestId("panel-drop-marker");
  await expect(marker).toHaveCount(1);
  await expect(group(page, 1).locator('[data-tab-id="diff"] [data-testid="panel-drop-marker"]')).toHaveCount(1);
  const m = await rect(marker);
  expect(m.left).toBeLessThan(diff.left + 4);
  await page.mouse.up();
  await expect(tabsOf(page, 1)).toHaveText(["Files", "Diff"]);
  await expect(tabsOf(page, 0)).toHaveText(["#12"]);
  // The moved tab is active in its new group, which has focus.
  await expect(bodyOf(page, 1)).toHaveAttribute("data-tab-id", "files");
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(panel(page).getByTestId("panel-drop-marker")).toHaveCount(0);

  // Within group 1: Diff onto Files reorders as before.
  await startDrag(page, tabIn(page, 1, "Diff"), ...(await at(tabIn(page, 1, "Files"), 0.5, 0.5)));
  await expect(group(page, 1).getByTestId("panel-drop-marker")).toHaveCount(0);
  await page.mouse.up();
  await expect(tabsOf(page, 1)).toHaveText(["Diff", "Files"]);

  // Files back onto group 0's strip, over its "+": after #12.
  await startDrag(page, tabIn(page, 1, "Files"), ...(await at(group(page, 0).getByTestId("panel-new-tab"), 0.5, 0.5)));
  await expect(group(page, 0).getByTestId("panel-drop-marker")).toHaveCount(1);
  await page.mouse.up();
  await expect(tabsOf(page, 0)).toHaveText(["#12", "Files"]);
  await expect(tabsOf(page, 1)).toHaveText(["Diff"]);

  // alt+Right on group 0's last tab is clamped there: keyboard moves never leave the group.
  await tabIn(page, 0, "Files").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(tabsOf(page, 0)).toHaveText(["Files", "#12"]);
  await expect(tabsOf(page, 1)).toHaveText(["Diff"]);
});

test("a drop on the other group's body appends the tab there, tinting it while over; moving a group's last tab out collapses the split", async ({ page }) => {
  await panelWith(page, 420, THREE);
  await store(page, "movePanelTabToGroup", "current", "diff", 1);
  await expect(split(page)).toHaveAttribute("data-orientation", "stack");

  await startDrag(page, tabIn(page, 0, "Files"), ...(await at(bodyOf(page, 1), 0.5, 0.5)));
  const tint = group(page, 1).getByTestId("panel-drop-tint");
  await expect(tint).toBeVisible();
  await expect(group(page, 0).getByTestId("panel-drop-tint")).toHaveCount(0);
  await page.mouse.up();
  await expect(tint).toHaveCount(0);
  await expect(tabsOf(page, 1)).toHaveText(["Diff", "Files"]);
  await expect(tabsOf(page, 0)).toHaveText(["#12"]);
  await expect(bodyOf(page, 1)).toHaveAttribute("data-tab-id", "files");

  // Over its own body nothing is a target: the drop puts it back.
  await startDrag(page, tabIn(page, 0, "#12"), ...(await at(bodyOf(page, 0), 0.5, 0.5)));
  await expect(panel(page).getByTestId("panel-drop-tint")).toHaveCount(0);
  await page.mouse.up();
  await expect(tabsOf(page, 0)).toHaveText(["#12"]);

  // #12 was group 0's last tab: moving it out joins the groups, with #12 last and active.
  await startDrag(page, tabIn(page, 0, "#12"), ...(await at(bodyOf(page, 1), 0.5, 0.5)));
  await page.mouse.up();
  await expect(split(page)).not.toHaveAttribute("data-split");
  await expect(panel(page).getByRole("tab")).toHaveText(["Diff", "Files", "#12"]);
  await expect(bodyOf(page, 0)).toHaveAttribute("data-tab-id", "pullrequest?number=12");
});

test("a drag over the other group's HTML render keeps moving and drops on that body (the frame ignores the pointer while a tab is lifted)", async ({ page }) => {
  await panelWith(page, 420, THREE);
  // Split with Diff in group two, then open the mock's HTML page there (group two is focused).
  await store(page, "movePanelTabToGroup", "current", "diff", 1);
  await expect(split(page)).toHaveAttribute("data-split", "true");
  const target = JSON.stringify({ project: "repo-cf", base: CF, path: "docs/preview.html" });
  await page.evaluate(`import("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  const frame = group(page, 1).getByTestId("file-html-frame");
  await expect(frame).toBeVisible();
  await expect(page.frameLocator('[data-testid="file-html-frame"]').locator("#title")).toHaveText("script ran");
  // Not lifted, the page takes the pointer as before.
  expect(await frame.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");

  const underPointer = async (x: number, y: number) => {
    const g = await rect(ghost(page).first());
    expect(g.left <= x && x <= g.right && g.top <= y && y <= g.bottom, `ghost ${JSON.stringify(g)} under (${String(x)}, ${String(y)})`).toBe(true);
  };
  const [x1, y1] = await at(frame, 0.3, 0.3);
  await startDrag(page, tabIn(page, 0, "Files"), x1, y1);
  await expect(panel(page)).toHaveAttribute("data-dragging", "true");
  expect(await frame.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await underPointer(x1, y1);
  // Further across the frame: the ghost follows (it froze at the frame's edge) and the body under the frame is the target.
  const [x2, y2] = await at(frame, 0.7, 0.7);
  await page.mouse.move(x2, y2, { steps: 8 });
  await underPointer(x2, y2);
  await expect(group(page, 1).getByTestId("panel-drop-tint")).toBeVisible();
  await page.mouse.up();

  await expect(tabsOf(page, 1)).toHaveText(["Diff", "preview.html", "Files"]);
  await expect(tabsOf(page, 0)).toHaveText(["#12"]);
  await expect(panel(page)).not.toHaveAttribute("data-dragging");
});

/** SHOTS=<dir>: mid-drag mock screenshots for docs/notes/panel-split-3-drag, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`split drag screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const shot = async (name: string) => {
      const r = await rect(panel(page));
      await page.screenshot({ path: `${String(shots)}/${name}-${scheme}.png`, clip: { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 } });
    };
    await page.emulateMedia({ colorScheme: scheme });
    await panelWith(page, 760, THREE);
    await startDrag(page, tabIn(page, 0, "Diff"), ...(await at(bodyOf(page, 0), 0.8, 0.4)));
    await expect(band(page)).toHaveAttribute("data-over", "true");
    await page.waitForTimeout(300);
    await shot("drop-band-side");
    await page.mouse.up();
    await expect(tabsOf(page, 1)).toHaveText(["Diff"]);

    await setPanelWidth(page, 420);
    await startDrag(page, tabIn(page, 0, "Files"), ...(await at(bodyOf(page, 1), 0.5, 0.5)));
    await expect(group(page, 1).getByTestId("panel-drop-tint")).toBeVisible();
    await page.waitForTimeout(300);
    await shot("drop-body-stack");
    await page.mouse.up();

    await store(page, "unsplitPanel", "current");
    await startDrag(page, tabIn(page, 0, "#12"), ...(await at(bodyOf(page, 0), 0.5, 0.75)));
    await expect(band(page)).toHaveAttribute("data-over", "true");
    await page.waitForTimeout(300);
    await shot("drop-band-stack");
    await page.mouse.up();
    await expect(tabsOf(page, 1)).toHaveText(["#12"]);
  });
}
