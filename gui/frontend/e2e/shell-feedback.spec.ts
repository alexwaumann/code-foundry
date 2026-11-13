import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, mockUrl, resetMock } from "./fixtures";

/**
 * The owner's test feedback on the shell (docs/notes/shell-25a-test-feedback.md), what only a
 * browser shows: at the window's minimum width the panes of a column fold together rather than
 * being drawn at half their minimum; a short row folds to horizontal strips. Which panes fold is
 * vitest's (shell/geometry/rails.test.ts). SHOTS=<dir> for the PR's screenshots of every item
 * (WebKit, dark and light); they run on the tree before the change as well, for the "before".
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };
type Draft = { id: string; label: string; params: Record<string, string> };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: CF }, title: "Diff" });
const prs: Tab = { id: "t-prs", kind: "prs", title: "Pull Requests" };
const projects: Tab = { id: "t-projects", kind: "projects", title: "Projects" };
const compose = (draft: string): Tab => ({ id: `t-c-${draft}`, kind: "compose", params: { draft } });
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });
const split = (id: string, dir: "row" | "col", sizes: number[], ...kids: Node[]): Node => ({ t: "split", id, dir, sizes, kids });

async function seed(root: Node, focus: string, mru: string[] = [], drafts: Draft[] = []): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru, drafts }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function openShell(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

/** Sizes the window so the grid is `w` px wide (the sidebar keeps its own width). */
async function gridWidth(page: Page, w: number): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1400, height: 900 };
  const grid = await page.getByTestId("shell-grid").boundingBox();
  if (!grid) throw new Error("no grid");
  await page.setViewportSize({ width: Math.round(vp.width - grid.width + w), height: vp.height });
  await expect.poll(async () => Math.round((await page.getByTestId("shell-grid").boundingBox())?.width ?? 0)).toBe(w);
}

const rails = (page: Page) => page.getByTestId("shell-rail").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-pane-id") ?? ""}:${e.getAttribute("data-orientation") ?? ""}`).sort());
const paneBox = async (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`).boundingBox();

/**
 * The owner's layout: a thread (s-1), a column of a draft over a thread (s-3), a pane with a
 * thread (s-4), s-1's diff, Pull Requests and Projects; one thread (s-5) under the row.
 */
function ownerLayout(active: string): Node {
  return split(
    "s-root",
    "col",
    [0.6, 0.4],
    split(
      "s-row",
      "row",
      [0.33, 0.33, 0.34],
      pane("p-a", [thread("s-1")]),
      split("s-mid", "col", [0.5, 0.5], pane("p-cmp", [compose("d-1")]), pane("p-b", [thread("s-3")])),
      pane("p-c", [thread("s-4"), diff("s-1"), prs, projects], active),
    ),
    pane("p-d", [thread("s-5")]),
  );
}
const OWNER_DRAFTS: Draft[] = [{ id: "d-1", label: "this is pretty cool", params: {} }];
/** The window's minimum width (940) less the default sidebar and its gaps. */
const MIN_GRID = 644;

test.beforeEach(async () => {
  await resetMock();
});

test("at the minimum width, the middle column folds whole instead of being drawn at half its minimum", async ({ page }) => {
  await seed(ownerLayout("t-diff-s-1"), "p-c", ["t-diff-s-1", "t-s-1"], OWNER_DRAFTS);
  await openShell(page, 1400, 900);
  await gridWidth(page, MIN_GRID);
  await expect.poll(() => rails(page)).toEqual(["p-b:vertical", "p-cmp:vertical"]);
  // The diff's thread and the diff share what is left; nothing else is open in the row.
  const a = await paneBox(page, "p-a");
  const c = await paneBox(page, "p-c");
  expect(Math.round((a?.width ?? 0) / (c?.width ?? 1) * 100) / 100).toBeCloseTo(360 / 260, 1);
});

test("a row too short for its panes folds them to horizontal strips", async ({ page }) => {
  await seed(split("s-root", "col", [0.5, 0.5], split("s-row", "row", [0.5, 0.5], pane("p-a", [diff("s-1"), thread("s-3")]), pane("p-b", [prs, projects])), pane("p-c", [thread("s-1")])), "p-c", ["t-s-1"]);
  await openShell(page, 1400, 420);
  await expect.poll(() => rails(page)).toEqual(["p-a:horizontal", "p-b:horizontal"]);
  const strip = await page.locator('[data-testid="shell-rail"][data-pane-id="p-a"]').boundingBox();
  expect(Math.round(strip?.height ?? 0)).toBe(36);
  // Its tabs' icons, the selected one marked, a click unfolds it on that tab.
  await expect(page.locator('[data-testid="shell-rail"][data-pane-id="p-a"] [data-testid="shell-rail-tab"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="shell-rail"][data-pane-id="p-a"] [data-testid="shell-rail-tab"][data-active]')).toHaveAttribute("data-tab-id", "t-diff-s-1");
});

/** SHOTS=<dir>: every item of the feedback, dark and light; the same scenes on the tree before it. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell feedback screenshots (${scheme})`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    // The pointer off every control, and finite animations (a card's fade) done; a spinner runs for ever.
    const settle = async () => {
      await page.mouse.move(5, 5);
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
    };

    // 1 and 3: two threads side by side, the left focused (its accent border); its info toggled off.
    await seed(split("s-root", "row", [0.5, 0.5], pane("p-1", [thread("s-1")]), pane("p-2", [thread("s-3")])), "p-1", ["t-s-1"]);
    await openShell(page, 2400, 900);
    const toggle = page.locator('[data-testid="shell-pane"][data-pane-id="p-1"]').getByTestId("thread-info-toggle");
    const was = await toggle.getAttribute("aria-pressed");
    await toggle.click();
    await expect(toggle).not.toHaveAttribute("aria-pressed", was ?? "");
    await settle();
    await page.screenshot({ path: at("feedback-1-3-info-focus") });

    // 5: the owner's layout at the minimum width, the diff focused, then Pull Requests.
    await seed(ownerLayout("t-diff-s-1"), "p-c", ["t-diff-s-1", "t-s-1"], OWNER_DRAFTS);
    await openShell(page, 1400, 900);
    await gridWidth(page, MIN_GRID);
    await settle();
    await page.screenshot({ path: at("feedback-5-rails-diff") });
    await seed(ownerLayout("t-prs"), "p-c", ["t-prs", "t-s-1"], OWNER_DRAFTS);
    await page.reload();
    await expect(page.getByTestId("shell-grid")).toBeVisible();
    await settle();
    await page.screenshot({ path: at("feedback-5-rails-prs") });

    // 6: a row of two panes over a thread, in a short window.
    await seed(split("s-root", "col", [0.5, 0.5], split("s-row", "row", [0.5, 0.5], pane("p-a", [diff("s-1"), thread("s-3")]), pane("p-b", [prs, projects])), pane("p-c", [thread("s-1")])), "p-c", ["t-s-1"]);
    await openShell(page, 1400, 420);
    await settle();
    await page.screenshot({ path: at("feedback-6-short-row") });

    // 7 and 9: drafts in the sidebar, and a thread woken from a snooze (s-8, woken in the window's store).
    await seed(pane("p-1", [thread("s-1"), compose("d-notes")], "t-s-1"), "p-1", ["t-s-1"], [
      { id: "d-notes", label: "Write up the shell's sidebar for the release notes", params: { project: "repo-cf" } },
      { id: "d-empty", label: "", params: {} },
    ]);
    await openShell(page, 1400, 960);
    await page.evaluate(`__cfModule("/src/stores/threads.ts").then((m) => {
      const s = m.useThreadsStore.getState();
      const t = s.byId["s-8"];
      m.useThreadsStore.setState({ byId: { ...s.byId, "s-8": { ...t, snoozedUntilMs: null, status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() } } });
    })`);
    await settle();
    await page.screenshot({ path: at("feedback-7-9-sidebar"), clip: { x: 0, y: 0, width: 420, height: 960 } });

    // 8: the sidebar collapsed, a thread needing the user: the control after back and forward.
    await page.getByTestId("top-bar-sidebar-toggle").click();
    await settle();
    await page.screenshot({ path: at("feedback-8-topbar"), clip: { x: 0, y: 0, width: 700, height: 120 } });
  });
}
