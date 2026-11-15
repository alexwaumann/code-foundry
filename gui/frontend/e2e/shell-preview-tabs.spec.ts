import { expect, test, type Locator, type Page } from "@playwright/test";
import { appPath, mockUrl, resetMock } from "./fixtures";

/**
 * Preview tabs in the window (docs/notes/preview-tabs-3-gui.md), what only a browser shows: three
 * Archived rows clicked in turn leave one preview tab (the sidebar, the verb and the daemon's
 * stream together); the dashes are a real 1px dashed outline in the strip and the rail, in both
 * themes; and keeping a tab moves none of its neighbours. Which command a row runs, the keeps and
 * what reading does not keep are vitest's (ShellSidebarList, PaneTabStrip, PaneRail,
 * shell/preview tests). SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type PaneNode = { t: "pane"; id: string; tabs: Tab[]; active: string; collapsed?: boolean };
type Node = PaneNode | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id, key: `thread:${id}` });
const preview = (id: string): Tab => ({ ...thread(id), preview: true });
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): PaneNode => ({ t: "pane", id, tabs, active });
const twoPanes = (a: Node, b: Node): Node => ({ t: "split", id: "s-r", dir: "row", kids: [a, b], sizes: [0.5, 0.5] });

// The mock's world: s-7 "Spike a canvas sidebar" is archived.
const ARCHIVED = "s-7";

async function seed(root: Node, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [], drafts: [] }], current_space: "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

/** The stored tabs that are previews, by thread. */
async function storedPreviews(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  const spaces = ((await res.json()) as { state: { spaces: { root: Node | null }[] } }).state.spaces;
  const out: string[] = [];
  const walk = (n: Node | null): void => {
    if (!n) return;
    if (n.t === "pane") for (const t of n.tabs) if (t.preview === true) out.push(String(t.thread));
    if (n.t === "split") n.kids.forEach(walk);
  };
  spaces.forEach((s) => {
    walk(s.root);
  });
  return out;
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await expect(page.locator("[data-shell-list]")).toBeVisible();
}

const tabOf = (page: Page, id: string) => page.locator(`[data-testid="shell-tab"][data-tab-id="${id}"]`);

/** The ::after outline a preview draws: its style, width, radius and colour. */
function dashes(el: Locator) {
  return el.evaluate((e) => {
    const s = getComputedStyle(e, "::after");
    return { style: s.borderTopStyle, width: s.borderTopWidth, radius: s.borderTopLeftRadius, color: s.borderTopColor, inset: s.inset };
  });
}

test.beforeEach(async () => {
  await resetMock();
});

test("clicking three archived rows in turn leaves one preview tab: the last one's", async ({ page }) => {
  // s-7 is archived; two more join it.
  for (const id of ["s-3", "s-4"]) expect((await fetch(`${mockUrl}/__mock/thread/archive?id=${id}`, { method: "POST" })).ok).toBe(true);
  await seed(pane("p-1", [thread("s-1")]), "p-1");
  await openShell(page);
  const header = page.getByTestId("archived-header");
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  const rows = page.locator('[data-section="archived"][data-row-key^="s:"]');
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3);
  const ids = await rows.evaluateAll((els) => els.slice(0, 3).map((e) => (e.getAttribute("data-row-key") ?? "").slice(2)));
  const strip = page.locator('[data-testid="shell-pane"][data-pane-id="p-1"] [data-testid="shell-tab"]');
  for (const id of ids) {
    await page.locator(`[data-row-key="s:${id}"]`).click();
    await expect.poll(storedPreviews).toEqual([id]);
    await expect(page.locator('[data-testid="shell-tab"][data-preview]')).toHaveCount(1);
    await expect(strip).toHaveCount(2);
  }
  // Each replaced the last in its place: s-1, then the last row's preview.
  await expect(strip.nth(1)).toHaveAttribute("data-preview", "true");
  await expect(strip.nth(0)).not.toHaveAttribute("data-preview", /.*/);
});

for (const scheme of ["dark", "light"] as const) {
  test(`the dashes are a 1px dashed outline at the tab's radius, in the strip and the rail (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await seed(twoPanes(pane("p-1", [thread("s-1"), preview(ARCHIVED)], `t-${ARCHIVED}`), pane("p-2", [thread("s-2")])), "p-1");
    await openShell(page);
    const tab = tabOf(page, `t-${ARCHIVED}`);
    const strip = await dashes(tab);
    expect(strip).toMatchObject({ style: "dashed", width: "1px", radius: "6px" });
    // A kept tab draws none.
    expect((await dashes(tabOf(page, "t-s-1"))).style).not.toBe("dashed");
    // Not the accent nor the focus ring: the pane's focused border is the accent.
    const accent = await page.locator('[data-testid="shell-pane"][data-pane-id="p-1"]').evaluate((e) => getComputedStyle(e).borderTopColor);
    expect(strip.color).not.toBe(accent);

    await seed(twoPanes({ ...pane("p-1", [thread("s-1"), preview(ARCHIVED)], `t-${ARCHIVED}`), collapsed: true }, pane("p-2", [thread("s-2")])), "p-2");
    const icon = page.locator(`[data-testid="shell-rail-tab"][data-tab-id="t-${ARCHIVED}"]`);
    await expect(icon).toHaveAttribute("data-preview", "true");
    expect(await dashes(icon)).toMatchObject({ style: "dashed", width: "1px", radius: "6px", color: strip.color });
  });
}

test("a tab kept by a double click moves none of its neighbours", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1"), preview(ARCHIVED), thread("s-2"), thread("s-3")], `t-${ARCHIVED}`), "p-1");
  await openShell(page);
  const tabs = page.locator('[data-testid="shell-pane"][data-pane-id="p-1"] [data-testid="shell-tab"]');
  await expect(tabs).toHaveCount(4);
  const boxes = () => tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.x, r.y, r.width, r.height]));
  const before = await boxes();
  await tabOf(page, `t-${ARCHIVED}`).dblclick();
  await expect(tabOf(page, `t-${ARCHIVED}`)).not.toHaveAttribute("data-preview", /.*/);
  expect(await storedPreviews()).toEqual([]);
  expect(await boxes()).toEqual(before);
});

/**
 * SHOTS=<dir>: the strip with a preview shown in the focused pane, shown in a pane without the
 * focus, behind another tab, and in a rail; dark and light.
 */
for (const scheme of ["dark", "light"] as const) {
  test(`preview tab screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    const strips = async (name: string) => {
      const grid = await page.getByTestId("shell-grid").boundingBox();
      if (!grid) throw new Error("no grid");
      await page.waitForTimeout(150);
      await page.screenshot({ path: at(name), clip: { x: grid.x, y: grid.y, width: grid.width, height: 120 } });
    };
    const left = (active: string) => pane("p-1", [thread("s-1"), thread("s-2"), preview(ARCHIVED)], active);
    const right = pane("p-2", [thread("s-3"), thread("s-4")]);

    await seed(twoPanes(left(`t-${ARCHIVED}`), right), "p-1");
    await openShell(page);
    await expect(tabOf(page, `t-${ARCHIVED}`)).toBeVisible();
    await strips("preview-focused");

    await seed(twoPanes(left(`t-${ARCHIVED}`), right), "p-2");
    await expect(page.locator('[data-testid="shell-pane"][data-pane-id="p-2"]')).toHaveAttribute("data-focused", "true");
    await strips("preview-unfocused");

    await seed(twoPanes(left("t-s-2"), right), "p-1");
    await expect(tabOf(page, "t-s-2")).toHaveAttribute("data-active", "true");
    await strips("preview-behind");

    await seed(twoPanes({ ...left(`t-${ARCHIVED}`), collapsed: true }, right), "p-2");
    const rail = page.locator('[data-testid="shell-rail"][data-pane-id="p-1"]');
    await expect(rail).toBeVisible();
    const r = await rail.boundingBox();
    if (!r) throw new Error("no rail");
    await page.waitForTimeout(150);
    await page.screenshot({ path: at("preview-rail"), clip: { x: r.x - 8, y: r.y - 8, width: 360, height: 200 } });
  });
}
