import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, invocations, mockUrl, openStreams, resetMock } from "./fixtures";

/**
 * Rails in a small window (docs/notes/shell-model.md, "Small windows"; docs/notes/shell-19-rails-
 * fullscreen.md), what only a browser shows: the window shrinking folds panes to rails in order and
 * growing unfolds them, the stored layout untouched; a folded pane holds no stream; a click on a
 * rail's icon unfolds it; a tab dropped on a rail. Which panes fold for a size, the selected mark,
 * the dots and the tooltips are vitest's (components/shell/PaneGrid.rails.test.tsx). Set SHOTS=<dir>
 * for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const file = (thread: string, path: string): Tab => ({ id: `t-file-${path}`, kind: "file", thread, params: { project: "repo-cf", base: CF, path }, title: path.split("/").pop() ?? path });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const projects: Tab = { id: "t-projects", kind: "projects", title: "Projects" };
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });

/**
 * s-1 and s-3's threads (s-1 focused) between Pull Requests over Projects on the left and s-1's
 * linked surfaces with s-5's thread on the right. Minimums: 300 + 360 + 260 (the diff active) and
 * two gutters.
 */
const ROW: Node = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [pane("p-l", [prs, projects]), pane("p-m", [thread("s-1"), thread("s-3")]), pane("p-r", [diff("s-1"), file("s-1", "README.md"), thread("s-5")])],
  sizes: [0.25, 0.45, 0.3],
};

async function seed(root: Node | null, focus: string, mru: string[] = []): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function storedRoot(): Promise<Node | null> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { root: Node | null }[] } }).state.spaces[0]?.root ?? null;
}

/** The stored tree's shape: splits with their sizes, panes with their tabs and the active one (a surface's own params left out). */
function shape(n: Node | null): string {
  if (!n) return "";
  if (n.t === "pane") return `${n.id}[${n.tabs.map((t) => t.id).join(",")}:${n.active}]`;
  return `${n.dir}${JSON.stringify(n.sizes)}(${n.kids.map(shape).join(" ")})`;
}

const rails = (page: Page) => page.getByTestId("shell-rail").evaluateAll((els) => els.map((e) => e.getAttribute("data-pane-id") ?? "").sort());
const open = (page: Page) => page.getByTestId("shell-pane").evaluateAll((els) => els.map((e) => e.getAttribute("data-pane-id") ?? "").sort());
const railEl = (page: Page, id: string) => page.locator(`[data-testid="shell-rail"][data-pane-id="${id}"]`);
const watches = async () => (await openStreams())["ThreadService/WatchThread"] ?? 0;

/** Sizes the window so the grid is `w` px wide (the sidebar keeps its own width). */
async function gridWidth(page: Page, w: number): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1400, height: 900 };
  const grid = await page.getByTestId("shell-grid").boundingBox();
  if (!grid) throw new Error("no grid");
  await page.setViewportSize({ width: Math.round(vp.width - grid.width + w), height: vp.height });
  await expect.poll(async () => Math.round((await page.getByTestId("shell-grid").boundingBox())?.width ?? 0)).toBe(w);
}

async function openShell(page: Page, width = 2000, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("shrinking the window folds panes to rails in order, growing unfolds them, and the stored layout does not change", async ({ page }) => {
  await seed(ROW, "p-m", ["t-s-1", "t-diff-s-1", "t-prs"]);
  await openShell(page);
  const before = shape(await storedRoot());
  await gridWidth(page, 1500);
  await expect.poll(() => rails(page)).toEqual([]);
  // No room for a third pane's 480px: the pane without a thread tab folds first.
  await gridWidth(page, 1100);
  await expect.poll(() => rails(page)).toEqual(["p-l"]);
  expect(await open(page)).toEqual(["p-m", "p-r"]);
  // Less still: the right pane folds too; the focused thread's pane never does.
  await gridWidth(page, 600);
  await expect.poll(() => rails(page)).toEqual(["p-l", "p-r"]);
  expect(await open(page)).toEqual(["p-m"]);
  // The rails are 36px wide and the open pane takes the rest.
  expect(Math.round((await railEl(page, "p-l").boundingBox())?.width ?? 0)).toBe(36);
  // Growing unfolds them, in reverse.
  await gridWidth(page, 1100);
  await expect.poll(() => rails(page)).toEqual(["p-l"]);
  await gridWidth(page, 1500);
  await expect.poll(() => rails(page)).toEqual([]);
  expect(shape(await storedRoot())).toBe(before);
  expect((await invocations()).filter((i) => i.name === "pane.resize" || i.name.startsWith("tab.") || i.name.startsWith("pane.move"))).toEqual([]);
});

test("a folded pane holds no stream", async ({ page }) => {
  // s-5's thread active on the right: two threads on screen.
  await seed({ ...ROW, kids: [ROW.kids[0] as Node, ROW.kids[1] as Node, pane("p-r", [diff("s-1"), thread("s-5")], "t-s-5")] }, "p-m");
  await openShell(page);
  await gridWidth(page, 1500);
  await expect.poll(watches).toBe(2);
  await gridWidth(page, 600);
  await expect.poll(() => rails(page)).toEqual(["p-l", "p-r"]);
  await expect.poll(watches).toBe(1);
  await expect(page.getByTestId("thread-pane")).toHaveCount(1);
  await gridWidth(page, 1500);
  await expect.poll(watches).toBe(2);
});

test("a click on a rail's icon focuses that tab and unfolds the pane; another folds", async ({ page }) => {
  await seed(ROW, "p-m");
  await openShell(page);
  await gridWidth(page, 600);
  await expect.poll(() => rails(page)).toEqual(["p-l", "p-r"]);
  await railEl(page, "p-r").locator('[data-testid="shell-rail-tab"][data-tab-id="t-file-README.md"]').click();
  // The right pane is open on its file, focused; the thread's pane stays (its thread is the file's).
  await expect(page.locator('[data-testid="shell-pane"][data-pane-id="p-r"]')).toHaveAttribute("data-focused", "true");
  await expect(page.locator('[data-testid="shell-pane"][data-pane-id="p-r"] [data-testid="shell-tab"][data-active]')).toHaveAttribute("data-tab-id", "t-file-README.md");
  await expect.poll(() => open(page)).toEqual(["p-m", "p-r"]);
  expect(await rails(page)).toEqual(["p-l"]);
});

test("a tab dropped on a rail joins that pane, and the highlight is where the opened pane lands", async ({ page }) => {
  await seed(ROW, "p-m");
  await openShell(page);
  await gridWidth(page, 1100);
  await expect.poll(() => rails(page)).toEqual(["p-l"]);
  const from = await page.locator('[data-testid="shell-tab"][data-tab-id="t-s-3"]').boundingBox();
  const to = await railEl(page, "p-l").boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  // The whole rail is the target (the preview glides for 75ms). The rail takes the focus with
  // the tab, so it opens: the highlight is the open pane, not the 36px rail
  // (docs/notes/shell-25b-audits.md).
  await page.waitForFunction(() => document.querySelector('[data-testid="shell-drop-preview"]')?.getAnimations().length === 0);
  const preview = await page.getByTestId("shell-drop-preview").boundingBox();
  if (!preview) throw new Error("no preview");
  expect(preview.width).toBeGreaterThan(to.width * 2);
  await page.mouse.up();
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
  await expect.poll(async () => (await invocations()).find((i) => i.name === "tab.move")?.args).toMatchObject({ tab: "t-s-3", pane: "p-l" });
  await expect
    .poll(async () => {
      const root = await storedRoot();
      return root?.t === "split" ? root.kids.map((k) => (k.t === "pane" ? k.tabs.map((t) => t.id).join(",") : "")) : [];
    })
    .toEqual(["t-prs,t-projects,t-s-3", "t-s-1", "t-diff-s-1,t-file-README.md,t-s-5"]);
  const landed = page.locator('[data-testid="shell-pane"][data-pane-id="p-l"]');
  await expect(landed).toHaveAttribute("data-focused", "true");
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  const box = await landed.boundingBox();
  expect([box?.x, box?.y, box?.width, box?.height].map((v) => Math.round(v ?? -1))).toEqual([preview.x, preview.y, preview.width, preview.height].map(Math.round));
});

/** SHOTS=<dir>: a small window with two rails (the selected icons marked, an attention dot), dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell rails screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    // s-2 waits on a permission in the mock: its icon in the right rail has the attention dot.
    await seed({ ...ROW, kids: [ROW.kids[0] as Node, ROW.kids[1] as Node, pane("p-r", [diff("s-1"), file("s-1", "README.md"), thread("s-2")], "t-file-README.md")] }, "p-m");
    await openShell(page, 1100, 720);
    await gridWidth(page, 640);
    await expect.poll(() => rails(page)).toEqual(["p-l", "p-r"]);
    await expect(page.getByTestId("thread-pane")).toBeVisible();
    await page.mouse.move(700, 700);
    await page.screenshot({ path: `${shots ?? ""}/shell-rails${suffix}.png` });
  });
}
