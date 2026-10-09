import { expect, test, type Page } from "@playwright/test";
import { CF, emit, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Phase 3a: the Pull Requests page and the worktree overview, against the mock daemon
 * (mock/github.ts). Set SHOTS=<dir> to save screenshots.
 */

const CFW = `${CF}.worktrees`;
const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function ghCalls(): Promise<Record<string, number>> {
  const res = await fetch(`${mockUrl}/__mock/gh/calls`);
  return (await res.json()) as Record<string, number>;
}

const prRows = (page: Page, section: string) => page.getByTestId(`prs-${section}`).locator("[data-nav-key]");

test.beforeEach(async () => {
  await resetMock();
});

test.describe("Pull Requests page", () => {
  test("sidebar entry opens it: tiles, three sections filtered to registered repos", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const pageEl = page.getByTestId("prs-page");
    await expect(pageEl).toBeVisible();
    await expect(page.getByTestId("nav-pullrequests")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("prs-viewer")).toHaveText("@alexwaumann");
    await expect(page.getByTestId("prs-updated")).toHaveText(/updated \d+s ago/);
    await expect(page.getByTestId("tile-this-month-commits")).toHaveText("16");
    await expect(page.getByTestId("tile-this-month-merged")).toHaveText("2");
    await expect(page.getByTestId("tile-last-month-commits")).toHaveText("463");
    await expect(page.getByTestId("tile-last-month-merged")).toHaveText("38");
    // other-org/lib is not registered: filtered out of review and merged.
    await expect(prRows(page, "authored")).toHaveCount(3);
    await expect(prRows(page, "review")).toHaveCount(1);
    await expect(prRows(page, "merged")).toHaveCount(3);
    const first = prRows(page, "authored").first();
    await expect(first).toContainText("#142");
    await expect(first).toContainText("virtualized sidebar tree");
    await expect(first.locator("[data-checks]")).toHaveAttribute("data-checks", "success");
    await expect(first).toContainText("approved");
    await expect(prRows(page, "authored").nth(1).locator("[data-checks]")).toHaveAttribute("data-checks", "failure");
    await expect(prRows(page, "review").first()).toContainText("teammate-kim");
    await shot(page, "prs-page");

    // "A" shows every repository.
    await page.getByTestId("prs-list").press("a");
    await expect(page.getByTestId("prs-scope")).toHaveText("all repositories");
    await expect(prRows(page, "review")).toHaveCount(2);
    await expect(prRows(page, "merged")).toHaveCount(4);
  });

  test("Enter and click open pull requests in the side panel; cmd+Enter and cmd+click on GitHub", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const list = page.getByTestId("prs-list");
    await expect(list).toBeFocused();
    await list.press("ArrowDown");
    await expect(prRows(page, "authored").first()).toHaveAttribute("aria-selected", "true");
    await list.press("j");
    await list.press("Enter");
    const tabs = page.getByTestId("panel-tabs").getByRole("tab");
    await expect(tabs).toHaveText(["#145"]);
    await expect(page.getByTestId("pr-title")).toHaveText("fix(terminal): resize race between attach and first output");
    // The list keeps focus, so the keyboard goes on: cmd+Enter opens the row on GitHub.
    await expect(list).toBeFocused();
    await list.press("Meta+Enter");
    await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url)).toEqual([
      "https://github.com/alexwaumann/code-foundry/pull/145",
    ]);
    // End jumps to the last row (merged section); a click opens any row in the panel.
    await list.press("End");
    await expect(prRows(page, "merged").last()).toHaveAttribute("aria-selected", "true");
    await prRows(page, "review").first().click();
    await expect(tabs).toHaveText(["#145", "#139"]);
    await expect(prRows(page, "review").first()).toHaveAttribute("aria-selected", "true");
    // cmd+click opens it on GitHub and adds no tab.
    await prRows(page, "review").first().click({ modifiers: ["Meta"] });
    await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").length).toBe(2);
    const last = (await invocations()).filter((i) => i.name === "view.open.url").at(-1);
    expect(last?.args.url).toBe("https://github.com/alexwaumann/code-foundry/pull/139");
    await expect(tabs).toHaveCount(2);
  });

  test("cmd+shift+d runs view.pullrequests and the ShowView intent switches the page", async ({ page }) => {
    await openApp(page);
    await row(page, `w:repo-cf::${CFW}/feat-sidebar`).click();
    await expect(page.getByTestId("overview-page")).toBeVisible();
    await page.keyboard.press("Meta+Shift+d");
    await expect(page.getByTestId("prs-page")).toBeVisible();
    expect((await invocations()).some((i) => i.name === "view.pullrequests")).toBe(true);

    // An intent from the CLI (UiService.Emit) does the same.
    await row(page, "t:t-tmp").click();
    await expect(page.getByTestId("prs-page")).toHaveCount(0);
    expect(await emit({ showView: { name: "pullrequests" } })).toBeGreaterThan(0);
    await expect(page.getByTestId("prs-page")).toBeVisible();
    // Unknown views are ignored.
    await emit({ showView: { name: "nope" } });
    await expect(page.getByTestId("prs-page")).toBeVisible();
  });

  test("gh events refresh the page; a failed poll shows stale and the error", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    await expect(prRows(page, "authored")).toHaveCount(3);
    const before = (await ghCalls()).GetDashboard ?? 0;
    await mockPost("gh/update");
    await expect(prRows(page, "authored")).toHaveCount(4);
    await expect(prRows(page, "authored").first()).toContainText("#150");
    expect((await ghCalls()).GetDashboard ?? 0).toBeGreaterThan(before);
    // A failed poll arrives as a polled event only: no re-read, the header turns red.
    const reads = (await ghCalls()).GetDashboard ?? 0;
    await mockPost("gh/stale");
    await expect(page.getByTestId("prs-updated")).toHaveAttribute("data-freshness", "error");
    await expect(page.getByTestId("prs-updated")).toContainText("updated 10m ago");
    // A poll that changed nothing freshens the header, still without a re-read.
    await mockPost("gh/poll");
    await expect(page.getByTestId("prs-updated")).toHaveAttribute("data-freshness", "fresh");
    await expect(page.getByTestId("prs-updated")).toContainText(/updated \d+s ago/);
    expect((await ghCalls()).GetDashboard ?? 0).toBe(reads);
  });
});

test.describe("worktree overview", () => {
  test("feature worktree: sync line, GitHub activity, sessions, files tree, log", async ({ page }) => {
    await openApp(page);
    await row(page, `w:repo-cf::${CFW}/feat-sidebar`).click();
    await expect(page.getByTestId("overview-title")).toHaveText("code-foundry@feat/sidebar");
    const sync = page.getByTestId("sync-line");
    await expect(sync).toContainText("Upstream origin/feat/sidebar: ↑2");
    await expect(sync).toContainText("Base origin/main: ↑3 ↓1");
    // The mock flips the modified count between 3 and 4 every 8s (World tick).
    await expect(sync).toContainText(/[34] modified · 1 new/);

    const gh = page.getByTestId("gh-activity");
    await expect(page.getByTestId("gh-merged-stats")).toHaveText("My PRs merged: 2 this month · 7 last month");
    await expect(page.getByTestId("gh-commit-stats")).toHaveText("My commits: 9 this month · 75 last month");
    await expect(page.getByTestId("gh-default-branch")).toHaveAttribute("data-ci", "failure");
    await expect(page.getByTestId("gh-default-branch")).toContainText("2/16 failing");
    await expect(gh.locator('[data-nav-key^="c:"]')).toHaveCount(2);
    await expect(gh.locator('[data-nav-key^="c:"]').nth(1)).toContainText("continuous-integration/jenkins/branch");
    await expect(gh.locator('[data-nav-key^="m:"]')).toHaveCount(2); // #138 and #136 (code-foundry only)
    await expect(gh.locator('[data-nav-key="b:142"]')).toContainText("feat/sidebar → main");

    // Sessions on this worktree (2c) are still listed.
    await expect(page.getByRole("button", { name: /Investigate flaky e2e/ })).toBeVisible();

    const files = page.getByTestId("files-list");
    await expect(files).toHaveAttribute("data-virtual", "false");
    await expect(page.getByTestId("section-files")).toContainText("8 files");
    await expect(files.locator('[data-nav-key="d:gui/frontend/src"]')).toContainText("(5)");
    await expect(files.locator('[data-nav-key="f:gui/frontend/src/lib/old-tree.ts"] [data-status]')).toHaveText("D");
    await expect(files.locator('[data-nav-key="f:scratch.txt"] [data-status]')).toHaveText("?");
    await expect(files.locator('[data-nav-key="f:docs/notes/sidebar.md"]')).toContainText("← docs/sidebar.md");
    await expect(files.locator('[data-nav-key="f:assets/icon.png"]')).toContainText("bin");
    await expect(page.getByTestId("log-list").locator("[data-nav-key]")).toHaveCount(3);
    await expect(page.getByTestId("section-log")).toContainText("(3 commits)");
    await shot(page, "overview-feature");
  });

  test("keyboard: fold directories, open failing checks and commits", async ({ page }) => {
    await openApp(page);
    await row(page, `w:repo-cf::${CFW}/feat-sidebar`).click();
    const list = page.getByTestId("overview-list");
    await expect(list).toBeFocused();
    await expect(page.getByTestId("files-list")).toBeVisible();
    // First row: the first failing check; Enter opens its log.
    await list.press("ArrowDown");
    await list.press("Enter");
    await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url)).toEqual([
      "https://ci.example.com/job/code-foundry/main/812/",
    ]);
    // Click a directory, collapse it with ←, expand with →.
    const dir = page.locator('[data-nav-key="d:gui/frontend/src"]');
    await dir.click();
    await list.focus();
    await list.press("ArrowLeft");
    await expect(page.locator('[data-nav-key="f:gui/frontend/src/lib/tree.ts"]')).toHaveCount(0);
    await list.press("ArrowRight");
    await expect(page.locator('[data-nav-key="f:gui/frontend/src/lib/tree.ts"]')).toBeVisible();
    // End: the oldest commit; Enter opens it on GitHub.
    await list.press("End");
    await list.press("Enter");
    await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").at(-1)?.args.url).toMatch(
      /^https:\/\/github\.com\/alexwaumann\/code-foundry\/commit\/8e7d6c5b4a/,
    );
  });

  test("long file lists start collapsed and virtualize when expanded", async ({ page }) => {
    await openApp(page);
    await row(page, `w:repo-cf::${CFW}/fix-resize`).click();
    await expect(page.getByTestId("section-files")).toContainText("120 files");
    const files = page.getByTestId("files-list");
    await expect(files).toHaveAttribute("data-virtual", "false");
    await expect(files.locator('[data-nav-key^="d:"]').first()).toBeVisible();
    await expect(files.locator('[data-nav-key^="f:"]')).toHaveCount(0);
    const list = page.getByTestId("overview-list");
    await list.press("e");
    await expect(files).toHaveAttribute("data-virtual", "true");
    const mounted = await files.locator("[data-nav-key]").count();
    expect(mounted).toBeGreaterThan(10);
    expect(mounted).toBeLessThan(120);
    // The cursor reaches rows that were not mounted.
    await list.press("End");
    await expect(page.getByTestId("log-list").locator("[data-nav-key]").last()).toHaveAttribute("aria-selected", "true");
    await shot(page, "overview-long");
    await list.press("E");
    await expect(files.locator('[data-nav-key^="f:"]')).toHaveCount(0);
  });

  test("detail updates live; main worktree shows untracked files and an empty log", async ({ page }) => {
    await openApp(page);
    await row(page, `r:repo-cf`).click();
    await expect(page.getByTestId("overview-title")).toHaveText("code-foundry@main");
    await expect(page.locator('[data-nav-key="f:.pr1853.diff"]')).toContainText("+1368");
    await expect(page.locator('[data-nav-key="f:notes/"] [data-status]')).toHaveText("?");
    await expect(page.getByTestId("section-log")).toContainText("no commits in range");
    await expect(page.getByTestId("sync-line")).toContainText("✓ in sync");

    const before = (await ghCalls()).GetWorktreeDetail ?? 0;
    await mockPost(`gh/touch?path=${encodeURIComponent(CF)}`);
    await expect(page.locator('[data-nav-key="f:later.txt"]')).toBeVisible();
    expect((await ghCalls()).GetWorktreeDetail ?? 0).toBeGreaterThan(before);
  });

  test("a repo without a GitHub remote says so", async ({ page }) => {
    await openApp(page);
    await row(page, `r:repo-dot`).click();
    await expect(page.getByTestId("section-github")).toContainText("No GitHub remote");
  });
});
