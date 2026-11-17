import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, mockUrl, resetMock } from "./fixtures";

/**
 * A click on a rail's empty area opens the pane (docs/notes/shell-model.md, "Small windows" and
 * "Collapsing a pane"; docs/notes/shell-25j-rail-click.md), what only a browser shows: a real
 * pointer on the empty part of a collapsed rail in a row, of a collapsed strip in a column and of
 * a rail folded for lack of room opens that pane; a tab dragged out of a collapsed rail moves and
 * the rail stays collapsed (the drag is not a click). Which click runs which verb is vitest's
 * (components/shell/PaneRail.click.test.tsx). SHOTS=<dir> for the PR's screenshots (WebKit, dark
 * and light): a hovered rail.
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string; collapsed?: boolean } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const projects: Tab = { id: "t-projects", kind: "projects", title: "Projects" };
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });
const collapsed = (n: Node): Node => ({ ...n, collapsed: true }) as Node;

/** Pull Requests and Projects (Projects selected), s-1's thread, s-1's diff, in a row. */
const ROW: Node = { t: "split", id: "s-r", dir: "row", kids: [pane("p-l", [prs, projects], "t-projects"), pane("p-m", [thread("s-1")]), pane("p-r", [diff("s-1")])], sizes: [0.3, 0.4, 0.3] };

/** s-1's thread beside a column of Pull Requests and Projects (collapsed) over s-1's diff. */
const COL: Node = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [pane("p-m", [thread("s-1")]), { t: "split", id: "s-c", dir: "col", kids: [collapsed(pane("p-a", [prs, projects], "t-projects")), pane("p-b", [diff("s-1")])], sizes: [0.5, 0.5] }],
  sizes: [0.5, 0.5],
};

async function seed(root: Node, focus: string, mru: string[] = []): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function storedRoot(): Promise<Node | null> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { root: Node | null }[] } }).state.spaces[0]?.root ?? null;
}

/** Each stored pane: its tabs, and a * when it is collapsed. */
async function storedPanes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = (n: Node | null) => {
    if (!n) return;
    if (n.t === "pane") out[n.id] = n.tabs.map((t) => t.id).join(",") + (n.collapsed ? " *" : "");
    else n.kids.forEach(walk);
  };
  walk(await storedRoot());
  return out;
}

const railEl = (page: Page, id: string) => page.locator(`[data-testid="shell-rail"][data-pane-id="${id}"]`);
const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);
const activeTab = (page: Page, id: string) => paneEl(page, id).locator('[data-testid="shell-tab"][data-active]');

/** A point on the rail's empty part: under the controls of a rail, between the icons and the controls of a strip. */
async function emptyPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await railEl(page, id).boundingBox();
  if (!b) throw new Error(`no rail ${id}`);
  return b.height >= b.width ? { x: b.x + b.width / 2, y: b.y + b.height - 24 } : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function openShell(page: Page, width = 2200, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("a click on the empty part of a collapsed rail in a row, and of a collapsed strip in a column, opens it on its selected tab", async ({ page }) => {
  await seed({ ...ROW, kids: [collapsed(ROW.kids[0] as Node), ROW.kids[1] as Node, ROW.kids[2] as Node] }, "p-m");
  await openShell(page);
  await expect(railEl(page, "p-l")).toHaveAttribute("data-orientation", "vertical");
  const at = await emptyPoint(page, "p-l");
  await page.mouse.click(at.x, at.y);
  await expect(paneEl(page, "p-l")).toHaveAttribute("data-focused", "true");
  await expect(activeTab(page, "p-l")).toHaveAttribute("data-tab-id", "t-projects");
  expect((await storedPanes())["p-l"]).toBe("t-prs,t-projects");

  await seed(COL, "p-m");
  await page.reload();
  await expect(railEl(page, "p-a")).toHaveAttribute("data-orientation", "horizontal");
  const s = await emptyPoint(page, "p-a");
  await page.mouse.click(s.x, s.y);
  await expect(paneEl(page, "p-a")).toHaveAttribute("data-focused", "true");
  await expect(activeTab(page, "p-a")).toHaveAttribute("data-tab-id", "t-projects");
  expect((await storedPanes())["p-a"]).toBe("t-prs,t-projects");
});

test("a click on the empty part of a rail folded for lack of room unfolds it on its selected tab", async ({ page }) => {
  await seed(ROW, "p-m", ["t-s-1", "t-diff-s-1"]);
  // Room for two panes only: Pull Requests' pane folds first.
  await openShell(page, 1400);
  await expect(railEl(page, "p-l")).toBeVisible();
  await expect(railEl(page, "p-l")).not.toHaveAttribute("data-collapsed", "true");
  const at = await emptyPoint(page, "p-l");
  await page.mouse.click(at.x, at.y);
  await expect(paneEl(page, "p-l")).toHaveAttribute("data-focused", "true");
  await expect(activeTab(page, "p-l")).toHaveAttribute("data-tab-id", "t-projects");
});

test("a tab dragged out of a collapsed rail moves, and the rail stays collapsed", async ({ page }) => {
  await seed({ ...ROW, kids: [collapsed(ROW.kids[0] as Node), ROW.kids[1] as Node, ROW.kids[2] as Node] }, "p-m");
  await openShell(page);
  const from = await railEl(page, "p-l").locator('[data-testid="shell-rail-tab"][data-tab-id="t-prs"]').boundingBox();
  const to = await paneEl(page, "p-r").boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
  await expect.poll(storedPanes).toEqual({ "p-l": "t-projects *", "p-m": "t-s-1", "p-r": "t-diff-s-1,t-prs" });
  await expect(railEl(page, "p-l")).toHaveAttribute("data-collapsed", "true");
});

/** SHOTS=<dir>: a collapsed rail with the pointer on its empty part, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell rail click screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/rail-${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed({ ...ROW, kids: [collapsed(ROW.kids[0] as Node), ROW.kids[1] as Node, ROW.kids[2] as Node] }, "p-m");
    await openShell(page, 1800, 760);
    await expect(page.getByTestId("thread-pane")).toBeVisible();
    const p = await emptyPoint(page, "p-l");
    await page.mouse.move(p.x, p.y - 300);
    const r = await railEl(page, "p-l").boundingBox();
    if (!r) throw new Error("no rail");
    await page.screenshot({ path: at("hover"), clip: { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: 240, height: 260 } });
    await page.screenshot({ path: at("hover-full") });
  });
}
