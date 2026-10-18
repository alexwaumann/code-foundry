import { expect, test, type Page } from "@playwright/test";
import { CF, emit, invocations, mockPost, mockUrl, openApp, openProjects, resetMock, row, selectProject, selectWorktree } from "./fixtures";

/**
 * The Worktree surface as a side panel tab (docs/notes/worktree-panel-tab.md): the
 * Projects page's rows open it in the page's own panel; a thread opens its own worktree
 * with T, view.panel.worktree, or the empty panel's list. Then the overview itself
 * (docs/notes/worktree-panel-distill.md): who else, the git operation strip, the facts,
 * the branch's pull request, changes and commits. SHOTS=<dir> saves screenshots.
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const surface = (page: Page) => page.getByTestId("worktree-surface");
const FEAT = `${CF}.worktrees/feat-sidebar`;
const RESIZE = `${CF}.worktrees/fix-resize`;

const inPanel = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-region="panel"]') !== null);

test.beforeEach(async () => {
  await resetMock();
});

test("double-click on a worktree row and on a project row opens their tabs in the Projects page's panel; the page keeps focus", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await expect(panel(page)).toHaveCount(0);

  await page.locator(`[data-nav-key="pw:repo-cf::${FEAT}"]`).dblclick();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "view:projects");
  await expect(tabs(page)).toHaveText(["code-foundry · feat/sidebar"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "worktree");
  await expect(surface(page)).toHaveAttribute("data-path", FEAT);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("code-foundry@feat/sidebar");
  await expect(surface(page).getByTestId("worktree-changes")).toBeVisible();
  // The page is still the content and keeps the keyboard.
  await expect(page.getByTestId("projects-page")).toBeVisible();
  expect(await inPanel(page)).toBe(false);

  // A project row: its main worktree, titled with the project alone.
  await page.locator('[data-nav-key="p:repo-cf"]').dblclick();
  await expect(tabs(page)).toHaveText(["code-foundry · feat/sidebar", "code-foundry"]);
  await expect(surface(page)).toHaveAttribute("data-path", CF);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");

  // The same worktree again activates its tab rather than adding one.
  await page.locator(`[data-nav-key="pw:repo-cf::${FEAT}"]`).dblclick();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveText("code-foundry · feat/sidebar");
});

test("Enter on a workspace member row opens its tab in the page's panel", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);
  const member = page.locator('[data-nav-key="m:w-000000000001::repo-gp"]');
  await member.click();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "view:projects");
  await expect(tabs(page)).toHaveText(["ghostty-playground · cf/login"]);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("ghostty-playground@cf/login");
  await expect(page.getByTestId("projects-page")).toBeVisible();
});

test("a project without git: its tab says so and offers Initialize Git; the thread row menu shows a thread's worktree", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await page.locator('[data-nav-key="p:repo-wr"]').dblclick();
  await expect(surface(page)).toHaveAttribute("data-git", "false");
  await expect(surface(page).getByTestId("section-nogit")).toContainText("Not a git repository");
  await expect(surface(page).getByTestId("init-git")).toBeEnabled();

  // Show worktree on a thread row: the thread's own panel, with its worktree tab, focused.
  await row(page, "s:s-3").click({ button: "right" });
  await page.getByTestId("row-menu").getByText("Show worktree").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-3");
  await expect(tabs(page)).toHaveText(["code-foundry · fix/resize"]);
  await expect.poll(() => inPanel(page)).toBe(true);
});

test("a thread's panel lists Worktree with T; T, the list entry and the palette command open the thread's own worktree", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  const entry = page.getByTestId("panel-empty").locator('[data-surface="worktree"]');
  await expect(entry).toHaveAttribute("data-availability", "enabled");
  await expect(entry).toContainText("Worktree");
  await expect(entry.locator("kbd")).toHaveText("T");

  await page.keyboard.press("t");
  await expect(tabs(page)).toHaveText(["code-foundry"]);
  await expect(surface(page)).toHaveAttribute("data-path", CF);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");
  // The content pane still shows the thread.
  await expect(page.getByTestId("thread-header")).toContainText("Refactor sidebar tree");

  // The palette lists the command for a thread; its presenter runs locally (no round
  // trip, like view.panel.workspace): the tab comes back and the panel takes focus.
  await page.keyboard.press("Meta+w");
  await expect(tabs(page)).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Worktree");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.worktree"]').click();
  await expect(palette).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["code-foundry"]);
  await expect.poll(() => inPanel(page)).toBe(true);
});

test("the CLI's ShowView reaches the window; a page has no Worktree entry", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  expect(await emit({ showView: { name: "panel.worktree" } })).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-2");
  await expect(tabs(page)).toHaveText(["ghostty-playground"]);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("ghostty-playground@main");

  await page.getByTestId("nav-pullrequests").click();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "view:pullrequests");
  await expect(page.getByTestId("panel-empty").locator('[data-surface="worktree"]')).toHaveCount(0);
  // The ShowView is ignored here: nothing to open.
  await emit({ showView: { name: "panel.worktree" } });
  await expect(tabs(page)).toHaveCount(0);
});

// ---- the overview -------------------------------------------------------------------

const shots = process.env.SHOTS;
/** Dark and light, at the current panel width. */
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.getByTestId("side-panel").screenshot({ path: `${shots}/${name}-${scheme}-${test.info().project.name}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(width)}))`);
  await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(width);
}

const changes = (page: Page) => page.getByTestId("changes-list");
const fileRow = (page: Page, path: string) => changes(page).locator(`[data-nav-key="f:${path}"]`);
const commitsRow = (page: Page) => page.getByTestId("worktree-commits").locator('[data-nav-key="commits"]');
const opened = async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url);

/** Right edges of a column's cells, rounded: one value when the column lines up. */
async function rightEdges(page: Page, testId: string): Promise<number[]> {
  const edges = await changes(page).getByTestId(testId).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  return [...new Set(edges)];
}

/**
 * How a file row's path renders: whether the name is cut, whether the directory is, and
 * whether the directory's characters are visible and in reading order (the rtl box with
 * LRMs must not reorder "a/b/" into "/a/b"). Under an ellipsis, WebKit reports the hidden
 * characters' boxes at odd places: only the visible tail's order means anything there.
 */
function pathLayout(page: Page, path: string) {
  return fileRow(page, path)
    .getByTestId("file-path")
    .evaluate((el) => {
      const dir = el.querySelector<HTMLElement>('[data-testid="file-dir"]');
      const name = el.querySelector<HTMLElement>('[data-testid="file-name"]');
      if (!dir || !name) throw new Error("no dir or name");
      const text = dir.firstChild as Text;
      const charRect = (i: number) => {
        const r = document.createRange();
        r.setStart(text, i);
        r.setEnd(text, i + 1);
        return r.getBoundingClientRect();
      };
      // Skip the LRMs at both ends.
      const first = charRect(1);
      const beforeLast = charRect(text.length - 3);
      const last = charRect(text.length - 2);
      const box = dir.getBoundingClientRect();
      return {
        nameCut: name.scrollWidth > name.clientWidth,
        dirCut: dir.scrollWidth > dir.clientWidth,
        inOrder: first.left < last.left,
        tailInOrder: beforeLast.left < last.left,
        firstVisible: first.left >= box.left - 0.5,
        lastVisible: last.right <= box.right + 0.5,
        dirEndsAtName: Math.abs(box.right - name.getBoundingClientRect().left) < 1,
      };
    });
}

test.describe("the overview", () => {
  test("a shared feature worktree: who else, facts, the branch's pull request, aligned changes, collapsed commits", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", FEAT);
    const s = surface(page);
    // s-4 and s-5 run here, and top; the Projects page has no thread of its own.
    await expect(s.getByTestId("worktree-who")).toHaveText("2 other threads1 shell");
    await expect(s.getByTestId("fact-origin")).toHaveText("origin↑2 to push");
    await expect(s.getByTestId("fact-base")).toHaveText("vs main↑3 ↓1");
    // The mock flips the modified count between 3 and 4 every 8s (World tick): + 1 untracked.
    await expect(s.getByTestId("fact-tree")).toHaveText(/^working tree[45] changed$/);
    await expect(s.getByTestId("worktree-operation")).toHaveCount(0);

    const pr = s.getByTestId("overview-pr");
    await expect(pr).toHaveAttribute("data-number", "142");
    await expect(pr).toHaveAttribute("data-state", "open");
    await expect(pr).toContainText("feat(gui): virtualized sidebar tree with thread rows");

    await expect(s.getByTestId("changes-totals")).toHaveText("8 files · +324 −147");
    await expect(s.getByTestId("worktree-changes")).toContainText("vs main");
    await expect(changes(page)).toHaveAttribute("data-virtual", "false");
    await expect(changes(page).locator("[data-nav-key]")).toHaveCount(8);
    await expect(fileRow(page, "gui/frontend/src/lib/old-tree.ts").locator("[data-status]")).toHaveText("D");
    await expect(fileRow(page, "scratch.txt").locator("[data-status]")).toHaveText("?");
    // Blank at zero; binary says so.
    await expect(fileRow(page, "gui/frontend/src/lib/old-tree.ts").getByTestId("file-added")).toHaveText("");
    await expect(fileRow(page, "gui/frontend/src/components/sidebar/SidebarRow.tsx").getByTestId("file-deleted")).toHaveText("");
    await expect(fileRow(page, "assets/icon.png").getByTestId("file-added")).toHaveText("bin");
    // + and − line up down the list.
    expect(await rightEdges(page, "file-added")).toHaveLength(1);
    expect(await rightEdges(page, "file-deleted")).toHaveLength(1);
    expect(await pathLayout(page, "docs/notes/sidebar.md")).toEqual({ nameCut: false, dirCut: false, inOrder: true, tailInOrder: true, firstVisible: true, lastVisible: true, dirEndsAtName: true });

    await expect(s.getByTestId("worktree-commits")).toHaveAttribute("data-open", "false");
    await expect(commitsRow(page)).toContainText("Commits3 ahead of main");
    await expect(commitsRow(page)).toContainText("newest 2h");
    await expect(page.getByTestId("commits-list")).toHaveCount(0);
    await commitsRow(page).click();
    await expect(page.getByTestId("commits-list").locator("[data-nav-key]")).toHaveCount(3);

    // Read-only, and the old panel's sections are gone.
    await expect(s.locator("button")).toHaveCount(0);
    for (const id of ["sync-line", "section-github", "gh-activity", "section-files", "files-list", "section-log", "log-list", "files-computed", "gh-updated"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await shot(page, "overview-feature");
  });

  test("the header rule spans the panel; at 280px the facts wrap two per row and long paths keep their names", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", FEAT);
    const body = page.getByTestId("panel-body");
    const edges = async () => {
      const h = await page.getByTestId("worktree-surface-header").boundingBox();
      const b = await body.evaluate((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().left + el.clientWidth }));
      return h ? [Math.round(h.x - b.left), Math.round(b.right - (h.x + h.width))] : null;
    };
    expect(await edges()).toEqual([0, 0]);
    const top = (id: string) => page.getByTestId(id).evaluate((el) => Math.round(el.getBoundingClientRect().top));
    expect(new Set([await top("fact-origin"), await top("fact-base"), await top("fact-tree")]).size).toBe(1);

    await setPanelWidth(page, 280);
    expect(await edges()).toEqual([0, 0]);
    expect(await top("fact-origin")).toBe(await top("fact-base"));
    expect(await top("fact-tree")).toBeGreaterThan(await top("fact-origin"));
    expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    // The directory gives way from its start; the name stays whole beside it.
    expect(await pathLayout(page, "gui/frontend/src/components/sidebar/SidebarRow.tsx")).toMatchObject({ nameCut: false, dirCut: true, lastVisible: true, dirEndsAtName: true });
    // "…src/lib/": what is left of the directory reads in order.
    expect(await pathLayout(page, "gui/frontend/src/lib/tree.ts")).toMatchObject({ nameCut: false, dirCut: true, tailInOrder: true, lastVisible: true, dirEndsAtName: true });
    expect(await rightEdges(page, "file-added")).toHaveLength(1);
    expect(await rightEdges(page, "file-deleted")).toHaveLength(1);
    await shot(page, "overview-280");
  });

  test("keyboard: the pull request, the files, then the commits row, which opens; Enter opens commits and the pull request", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", FEAT);
    const list = page.getByTestId("overview-list");
    await list.focus();
    await list.press("ArrowDown");
    await expect(page.locator('[data-nav-key="pr"]')).toHaveAttribute("aria-selected", "true");
    // cmd+Enter: on GitHub.
    await list.press("Meta+Enter");
    await expect.poll(opened).toEqual(["https://github.com/alexwaumann/code-foundry/pull/142"]);
    await list.press("ArrowDown");
    await expect(fileRow(page, "gui/frontend/src/components/sidebar/Sidebar.tsx")).toHaveAttribute("aria-selected", "true");
    await list.press("End");
    await expect(commitsRow(page)).toHaveAttribute("aria-selected", "true");
    await list.press("ArrowRight");
    await expect(page.getByTestId("worktree-commits")).toHaveAttribute("data-open", "true");
    await list.press("End");
    await list.press("Enter");
    await expect.poll(async () => (await opened()).at(-1)).toMatch(/^https:\/\/github\.com\/alexwaumann\/code-foundry\/commit\/8e7d6c5b4a/);
    expect(await opened()).toHaveLength(2);
    // Back to the commits row: ← folds it, and its rows leave the cursor's path.
    await list.press("ArrowUp");
    await list.press("ArrowUp");
    await list.press("ArrowUp");
    await expect(commitsRow(page)).toHaveAttribute("aria-selected", "true");
    await list.press("ArrowLeft");
    await expect(page.getByTestId("commits-list")).toHaveCount(0);
    // Enter on the pull request opens its tab beside this one.
    await list.press("Home");
    await list.press("Enter");
    await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
    await expect(tabs(page)).toHaveCount(2);
    // Enter (or Space) on a file opens its Diff tab: committed only, so on the branch (file-tabs.spec.ts).
    await tabs(page).first().click();
    await list.focus();
    await list.press("ArrowDown");
    await list.press("ArrowDown");
    await expect(fileRow(page, "gui/frontend/src/components/sidebar/Sidebar.tsx")).toHaveAttribute("aria-selected", "true");
    await list.press("Space");
    await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
    await expect(page.getByTestId("diff-tab")).toHaveAttribute("data-scope", "branch");
    await expect(tabs(page)).toHaveCount(3);
  });

  test("a rebase stopped on conflicts: the strip, the unmerged card, conflicts first; it clears when the rebase ends", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", FEAT);
    const s = surface(page);
    await mockPost(`worktree/operation?path=${encodeURIComponent(FEAT)}&op=rebase&step=3&total=6&conflicted=2&file=internal/driver/plan.go&file=internal/driver/plan_test.go`);
    const strip = s.getByTestId("worktree-operation");
    await expect(strip).toHaveAttribute("data-operation", "rebase");
    await expect(strip).toHaveText("Rebase in progress · 2 conflictsstep 3/6");
    await expect(s.getByTestId("fact-tree")).toHaveText("working tree2 unmerged");
    await expect(s.getByTestId("changes-totals")).toHaveText(/^10 files/);
    const rows = changes(page).locator("[data-nav-key]");
    await expect(rows.nth(0)).toHaveAttribute("data-nav-key", "f:internal/driver/plan.go");
    await expect(rows.nth(1)).toHaveAttribute("data-nav-key", "f:internal/driver/plan_test.go");
    await expect(rows.nth(0).locator("[data-status]")).toHaveText("U");
    await expect(rows.nth(0)).toContainText("conflict");
    await expect(rows.nth(2)).not.toContainText("conflict");
    // The strip sits between the header and the facts.
    const y = (id: string) => s.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top);
    expect(await y("worktree-operation")).toBeGreaterThan(await y("worktree-surface-header"));
    expect(await y("worktree-operation")).toBeLessThan(await y("worktree-facts"));
    await shot(page, "overview-rebase");

    // A cherry-pick records no steps; one conflict is singular.
    await mockPost(`worktree/operation?path=${encodeURIComponent(FEAT)}&op=cherry-pick&conflicted=1`);
    await expect(strip).toHaveText("Cherry-pick in progress · 1 conflict");

    await mockPost(`worktree/operation?path=${encodeURIComponent(FEAT)}`);
    await expect(strip).toHaveCount(0);
    await expect(s.getByTestId("fact-tree")).toHaveText(/changed$/);
    await expect(changes(page).locator('[data-status="U"]')).toHaveCount(0);
  });

  test("long lists: 120 files and 12 commits stay ten rows tall and scroll; a draft pull request", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", RESIZE);
    const s = surface(page);
    await expect(s.getByTestId("worktree-who")).toHaveText("1 other thread");
    const pr = s.getByTestId("overview-pr");
    await expect(pr).toHaveAttribute("data-state", "draft");
    await expect(pr).toContainText("#145");
    await expect(pr).toContainText("draft");
    await expect(pr).not.toContainText("changes requested");

    await expect(s.getByTestId("changes-totals")).toContainText("120 files");
    await expect(changes(page)).toHaveAttribute("data-virtual", "true");
    const height = async (id: string) => (await page.getByTestId(id).boundingBox())?.height ?? 0;
    expect(await height("changes-list")).toBeLessThanOrEqual(240.5);
    const mounted = await changes(page).locator("[data-nav-key]").count();
    expect(mounted).toBeGreaterThan(10);
    expect(mounted).toBeLessThan(120);

    await expect(commitsRow(page)).toContainText("12 ahead of main");
    await commitsRow(page).click();
    const commits = page.getByTestId("commits-list");
    await expect(commits).toHaveAttribute("data-virtual", "false");
    await expect(commits.locator("[data-nav-key]")).toHaveCount(12);
    expect(await height("commits-list")).toBeLessThanOrEqual(240.5);
    expect(await commits.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // The cursor reaches the last commit inside its scroller.
    const list = page.getByTestId("overview-list");
    await list.focus();
    await list.press("End");
    const last = commits.locator("[data-nav-key]").last();
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeInViewport();
    await shot(page, "overview-long");
  });

  test("the newest open pull request wins over a newer merged one; merged and closed say so", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", FEAT);
    const pr = surface(page).getByTestId("overview-pr");
    await expect(pr).toHaveAttribute("data-number", "142");
    const slug = "alexwaumann/code-foundry";
    await mockPost(`gh/branch-pr?slug=${slug}&head=feat/sidebar&number=160&title=Earlier%20attempt&state=merged&append=1`);
    await expect(pr).toHaveAttribute("data-number", "142");
    await mockPost(`gh/branch-pr?slug=${slug}&head=feat/sidebar&number=119&title=spike%3A%20FSEvents%20watcher&state=closed`);
    await expect(pr).toHaveAttribute("data-state", "closed");
    await expect(pr).toContainText("closed");
    await mockPost(`gh/branch-pr?slug=${slug}&head=feat/sidebar&number=125&title=theme-engine-4&state=merged&ago=86400000`);
    await expect(pr).toHaveAttribute("data-state", "merged");
    await expect(pr).toContainText("merged");
    await expect(pr).toContainText("1d");
    // Click opens the tab; cmd+click opens GitHub instead.
    await pr.locator('[data-nav-key="pr"]').click({ modifiers: ["Meta"] });
    await expect.poll(opened).toEqual([`https://github.com/${slug}/pull/125`]);
    await expect(tabs(page)).toHaveCount(1);
    await pr.locator('[data-nav-key="pr"]').click();
    await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
  });

  test("the main worktree: in sync, untracked rows, no commits row; the detail updates live", async ({ page }) => {
    await openApp(page);
    await selectProject(page, "repo-cf");
    const s = surface(page);
    await expect(s.getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");
    await expect(s.getByTestId("fact-origin")).toHaveText("originin sync");
    await expect(s.getByTestId("fact-base")).toHaveText("vs maineven");
    await expect(s.getByTestId("fact-tree")).toHaveText("working treeclean");
    await expect(fileRow(page, ".pr1853.diff")).toContainText("+1368");
    // An untracked directory arrives as its files, each with its line count.
    await expect(fileRow(page, "notes/todo.md").locator("[data-status]")).toHaveText("?");
    await expect(fileRow(page, "notes/todo.md").getByTestId("file-name")).toHaveText("todo.md");
    await expect(fileRow(page, "notes/plan.md")).toContainText("+12");
    await expect(s.getByTestId("worktree-commits")).toHaveCount(0);

    const calls = async () => ((await (await fetch(`${mockUrl}/__mock/gh/calls`)).json()) as Record<string, number>).GetWorktreeDetail ?? 0;
    const before = await calls();
    await mockPost(`gh/touch?path=${encodeURIComponent(CF)}`);
    await expect(fileRow(page, "later.txt")).toBeVisible();
    expect(await calls()).toBeGreaterThan(before);
  });

  test("a remote that is not GitHub: no pull request row, no Publish; no base: no base card", async ({ page }) => {
    await openApp(page);
    await selectProject(page, "repo-dot");
    const s = surface(page);
    await expect(s.getByTestId("worktree-facts")).toBeVisible();
    await expect(s.getByTestId("fact-origin")).toHaveText("originnot pushed");
    await expect(s.getByTestId("fact-base")).toHaveCount(0);
    await expect(s.getByTestId("overview-pr")).toHaveCount(0);
    await expect(s.getByTestId("no-remote")).toHaveCount(0);
  });
});
