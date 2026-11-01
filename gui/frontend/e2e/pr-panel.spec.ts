import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, resetMock, row, selectWorktree } from "./fixtures";

/**
 * The Pull request surface in the side panel, against the mock daemon's fixtures
 * (mock/prDetail.ts): #145 open with failing checks, threads, labels and reviewers;
 * #138 merged and revertable; #131 closed; #140 read-only; #142 mergeable; #146 from a
 * fork; #139 a teammate's, awaiting the viewer's review. Set SHOTS=<dir> to save
 * screenshots.
 */

const CFW = `${CF}.worktrees`;
const SLUG = "alexwaumann/code-foundry";
const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  // Popovers fade in; wait so the shot is not half transparent (spinners never finish).
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
  );
  await page.screenshot({ path: `${shots}/${name}.png` });
}

/** Screenshots are taken at 1400x900. */
async function shotViewport(page: Page): Promise<void> {
  if (shots) await page.setViewportSize({ width: 1400, height: 900 });
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  // Record copies: the async Clipboard API needs a permission (Chromium) or a gesture (WebKit).
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          w.__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  });
});

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const prRow = (page: Page, section: string, number: number) => page.getByTestId(`prs-${section}`).locator("[data-nav-key]").filter({ hasText: `#${String(number)}` });

async function openPrPage(page: Page): Promise<void> {
  await openApp(page);
  await page.getByTestId("nav-pullrequests").click();
  await expect(page.getByTestId("prs-list")).toBeFocused();
}

/** Opens a pull request in the current selection's panel through the app's own store (for PRs on no dashboard). */
async function openPr(page: Page, number: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(number)} }))`);
}

/** Sets the current selection's side panel width through the app's own panel store, and waits for it. */
async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(width)}))`);
  await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(width);
}

/** How far an element's content overflows it horizontally (0 or less: it fits). */
function overflowX(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);
}

async function boxOf(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

/** Whether `inner` lies horizontally inside `outer` (1px slack for rounding). */
function inside(inner: { x: number; width: number }, outer: { x: number; width: number }): boolean {
  return inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1;
}

function copied(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

// "a row on the Pull Requests page opens #145: header, reviewers, failing checks": src/components/pr/PullRequestSurface.test.tsx ("#145: header, reviewers, ...").
test("summary (screenshot)", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshot is all it adds");
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("2 failing");
  await shot(page, "chunk3-summary");
});

// Timeline's entries, order, commit links and inner tabs per panel tab: src/components/pr/PullRequestSurface.test.tsx ("Timeline").
test("Timeline at the default 420px: the counts end before the order toggle; the rail stops at the last entry's icon", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-tab-timeline").click();
  const entries = page.getByTestId("pr-timeline-entry");
  await expect(entries).toHaveCount(10);
  // The counts' text fits their box, and that box ends before the toggle (its icon).
  expect(await overflowX(page, "pr-timeline-counts")).toBeLessThanOrEqual(0);
  const counts = await boxOf(page, "pr-timeline-counts");
  expect(counts.x + counts.width).toBeLessThanOrEqual((await boxOf(page, "pr-timeline-order")).x);
  const lastBox = await entries.last().boundingBox();
  const railBox = await entries.last().getByTestId("pr-timeline-rail").boundingBox();
  expect(railBox && lastBox && railBox.y + railBox.height).toBeLessThanOrEqual((lastBox?.y ?? 0) + 25);
  await shot(page, "chunk3-timeline");
});

// The reviewer picker's requests and recents, the search from 2 characters, toggling requests,
// word matching ("jane doe" finds "Doe, Jane") and a refused request: src/components/pr/PullRequestSurface.test.tsx ("the reviewer picker").
test("reviewer picker (screenshots)", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-add-reviewer").click();
  const search = page.getByTestId("pr-reviewer-search");
  const cands = page.getByTestId("pr-reviewer-candidate");
  await expect(cands).toHaveCount(3);
  await shot(page, "chunk3-reviewers");
  await search.fill("zoe-zim");
  await expect(page.getByTestId("pr-reviewer-matches").getByTestId("pr-reviewer-candidate")).toHaveCount(1);
  await shot(page, "reviewer-search");
  // Requested, then withdrawn: it stays in Recent.
  await search.fill("lee");
  const lee = page.getByTestId("pr-reviewer-matches").getByTestId("pr-reviewer-candidate");
  await expect(lee).toHaveAttribute("data-login", "teammate-lee");
  await lee.click();
  await expect(page.getByTestId("pr-reviewer").filter({ hasText: "teammate-lee" })).toHaveCount(1);
  await search.fill("");
  await page.getByTestId("pr-reviewer-requested").getByTestId("pr-reviewer-candidate").filter({ hasText: "teammate-lee" }).click();
  await expect(page.getByTestId("pr-reviewer-recent").getByTestId("pr-reviewer-candidate")).toHaveCount(1);
  await shot(page, "reviewer-recent");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-reviewer-picker")).toHaveCount(0);

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByTestId("pr-add-reviewer").click();
  const matches = page.getByTestId("pr-reviewer-matches").getByTestId("pr-reviewer-candidate");
  await search.fill("jane doe");
  await expect(matches).toHaveCount(2);
  await shot(page, "reviewer-search-tokens");
  await matches.filter({ hasText: "jdoe" }).click();
  await expect(matches.filter({ hasText: "jdoe" }).getByLabel("Requested")).toBeVisible();
  await shot(page, "reviewer-search-tokens-requested");
});

// The menu's items, Refresh (and a failed one), Open on GitHub and Copy link: src/components/pr/PullRequestSurface.test.tsx ("the ⋯ menu").
test("shift+cmd+c copies the link while the panel has focus", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-title").click();
  await page.keyboard.press("Meta+Shift+c");
  await expect.poll(() => copied(page)).toEqual([`https://github.com/${SLUG}/pull/145`]);
  await expect(page.getByText("Link copied")).toBeVisible();
});

// "#138 (merged) offers Revert", "declining the revert's confirmation sends nothing" and "#140 (read
// access) explains the picker and has no revert; #131 is closed; unknown numbers say not found":
// src/components/pr/PullRequestSurface.test.tsx ("the ⋯ menu", "Summary").
test("merged pull request menu (screenshot)", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshot is all it adds");
  await openPrPage(page);
  await prRow(page, "merged", 138).click();
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu-revert")).toBeVisible();
  await shot(page, "chunk3-menu");
});

test("panel state is per selection; a thread or worktree on a PR branch enables the surface", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 142).click();
  await expect(tabs(page)).toHaveText(["#142"]);

  // A thread on main: its panel is its own, and main has no pull request.
  await row(page, "s:s-1").click();
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  await expect(page.locator('[data-surface="pullrequest"]')).toHaveAttribute("data-availability", "disabled");

  // A thread on fix/resize: the surface is enabled once its branch PRs load; P opens #145.
  await row(page, "s:s-3").click();
  await page.getByTestId("panel-toggle").first().click();
  const pr = page.locator('[data-surface="pullrequest"][data-availability]');
  await expect(pr).toHaveAttribute("data-availability", "enabled");
  await panel(page).focus();
  await page.keyboard.press("p");
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-title")).toContainText("resize race");

  // The Projects page has its own panel: a worktree row's Changes tab.
  await selectWorktree(page, "repo-cf", `${CFW}/feat-sidebar`);
  await expect(tabs(page)).toHaveText(["Changes · code-foundry · feat/sidebar"]);

  // Back on the Pull Requests page, its panel is as it was.
  await page.getByTestId("nav-pullrequests").click();
  await expect(tabs(page)).toHaveText(["#142"]);
  await expect(page.getByTestId("pr-tab-summary")).toHaveAttribute("aria-selected", "true");
});

test("light scheme", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshot is all it adds");
  await page.emulateMedia({ colorScheme: "light" });
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("2 failing");
  await shot(page, "chunk3-light-summary");
});

// Closing a tab drops its inner state (reopened, it starts on Summary): src/components/pr/PullRequestSurface.test.tsx ("closing a tab drops its inner state").
test("cmd+w from inside the surface closes its tab; the last tab gone, the panel hides", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await page.getByTestId("pr-title").click();
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
});

test("at 280px nothing overflows: header, inner tab bar, logins, popups; the active tab is revealed", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await setPanelWidth(page, 280);
  await expect(page.getByTestId("pr-surface")).toBeVisible();

  // Summary: the headline keeps its icon and number inside the bar.
  expect(await overflowX(page, "pr-header")).toBeLessThanOrEqual(0);
  expect(await overflowX(page, "pr-inner-bar")).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("2 failing");
  expect(inside(await boxOf(page, "pr-checks-summary"), await boxOf(page, "pr-inner-bar"))).toBe(true);
  // The repo link has its own row; the diffstat wraps under the branches.
  expect(inside(await boxOf(page, "pr-diffstat"), await boxOf(page, "pr-header"))).toBe(true);
  expect(inside(await boxOf(page, "pr-reviewers"), await boxOf(page, "side-panel"))).toBe(true);
  // Comment authors are not cut before their verdict.
  const cutComments = await page.getByTestId("pr-comment-author").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cutComments).toEqual([]);

  // Timeline: the counts give way; the order toggle stays reachable.
  await page.getByTestId("pr-tab-timeline").click();
  expect(await overflowX(page, "pr-inner-bar")).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("pr-timeline-counts")).toBeHidden();
  expect(inside(await boxOf(page, "pr-timeline-order"), await boxOf(page, "pr-inner-bar"))).toBe(true);
  const cut = await page.getByTestId("pr-timeline-author").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cut).toEqual([]);
  await page.getByTestId("pr-timeline-order").click();
  await expect(page.getByTestId("pr-timeline")).toHaveAttribute("data-order", "oldest");

  // Popups stay inside the panel.
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-menu"), await boxOf(page, "side-panel"))).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByTestId("pr-tab-summary").click();
  await page.getByTestId("pr-add-reviewer").click();
  await expect(page.getByTestId("pr-reviewer-picker")).toBeVisible();
  expect(inside(await boxOf(page, "pr-reviewer-picker"), await boxOf(page, "side-panel"))).toBe(true);
  await page.keyboard.press("Escape");
  // Review keeps its icons (the label is for screen readers); its menu and composer fit.
  expect((await boxOf(page, "pr-review-button")).width).toBeLessThan(48);
  await expect(page.getByTestId("pr-review-button")).toHaveAccessibleName("Review");
  await page.getByTestId("pr-review-button").click();
  await expect(page.getByTestId("pr-review-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-review-menu"), await boxOf(page, "side-panel"))).toBe(true);
  await page.getByTestId("pr-review-comment").click();
  expect(await overflowX(page, "pr-review-composer")).toBeLessThanOrEqual(0);
  expect(inside(await boxOf(page, "pr-review-submit"), await boxOf(page, "side-panel"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-review-composer")).toHaveCount(0);

  // Many tabs: each new one scrolls into view in the strip.
  for (const [section, n] of [["authored", 142], ["authored", 12], ["review", 139], ["merged", 138], ["merged", 136], ["merged", 10]] as const) {
    await prRow(page, section, n).click();
    await expect(tabs(page).last()).toHaveAttribute("aria-selected", "true");
    const strip = await boxOf(page, "panel-tabs");
    const active = await page.getByTestId("panel-tabs").locator(`[data-tab-id]:has([aria-selected="true"])`).boundingBox();
    expect(active && inside(active, strip)).toBe(true);
  }
  expect(await page.getByTestId("panel-tabs").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("long conversations and timelines are virtualized in the panel's scroll", async ({ page }) => {
  for (let i = 1; i <= 45; i++) await mockPost(`gh/pr-comment?number=145&body=${encodeURIComponent(`Note ${String(i)}`)}`);
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  const list = page.getByTestId("pr-comments-list");
  await expect(list).toHaveAttribute("data-virtual", "true");
  await expect(page.getByTestId("pr-comments")).toContainText("Comments(54)");
  expect(await page.getByTestId("pr-comment").count()).toBeLessThan(50);
  // Scrolled to the end, the oldest item (the outdated thread) is mounted and visible.
  const body = page.getByTestId("panel-body");
  await expect
    .poll(async () => {
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      return page.getByText("Why remove the size check?").isVisible();
    })
    .toBe(true);

  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByTestId("pr-tab-timeline").click();
  await expect(page.getByTestId("pr-timeline-list")).toHaveAttribute("data-virtual", "true");
  await expect
    .poll(async () => {
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      return page.locator('[data-testid="pr-timeline-entry"][data-kind="opened"]').isVisible();
    })
    .toBe(true);
});

// ---- Threads about a pull request (pr.ask, pr.explain, pr.fix.findings) ----

const selectedThread = (page: Page) => page.locator('[data-row-kind="thread"][aria-selected="true"]');

async function threadInvocations(name: string): Promise<{ args: Record<string, string>; worktree: string | undefined }[]> {
  return (await invocations()).filter((i) => i.name === name).map((i) => ({ args: i.args, worktree: i.context?.activeWorktreePath }));
}

// Explain's spinner while it starts, its args (no worktree from the page) and the started toast: src/components/pr/PullRequestSurface.test.tsx ("Explain this PR").
test("Explain this PR selects the new thread (the daemon's FocusThread), and the PR tab stays on the Pull Requests page", async ({ page }) => {
  await shotViewport(page);
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  // Let the menu's fade-in finish before the screenshot.
  await page.getByTestId("pr-menu").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await shot(page, "chunk4-menu");

  await page.getByTestId("pr-menu-explain").click();
  // The daemon's FocusThread selects the new thread; its own panel is untouched.
  await expect(selectedThread(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  await expect(panel(page)).toHaveCount(0);

  // Back on the Pull Requests page, its panel still shows #145 (menu closed).
  await page.getByTestId("nav-pullrequests").click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-title")).toContainText("resize race");
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
});

// The composer under the header, Escape into the panel, Shift+Enter, Enter sending pr.ask with the
// thread's worktree in the context: src/components/pr/PullRequestSurface.test.tsx ("Ask a question from a thread").
test("Ask from a thread's panel selects the new thread; back on that thread its panel keeps #145 without the composer", async ({ page }) => {
  await shotViewport(page);
  await openApp(page);
  await row(page, "s:s-1").click();
  await openPr(page, 145);
  await expect(tabs(page)).toHaveText(["#145"]);
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  const input = page.getByTestId("pr-ask-input");
  await expect(input).toBeFocused();
  await input.pressSequentially("Why does attach race the first output?");
  await shot(page, "chunk4-ask");
  await page.keyboard.press("Enter");
  await expect(selectedThread(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  await expect(panel(page)).toHaveCount(0);
  expect((await threadInvocations("pr.ask")).map((i) => i.worktree)).toEqual([CF]);

  await row(page, "s:s-1").click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-ask")).toHaveCount(0);
});

// "Fix findings: a failure toasts the daemon's hint; a retry prepares the worktree and selects the thread":
// src/components/pr/PullRequestSurface.test.tsx ("Fix findings"); the new thread's selection is the daemon's FocusThread, kept in the Explain test above.
const askInput = (page: Page) => page.getByTestId("pr-ask-input");

async function openAsk(page: Page): Promise<void> {
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  await expect(askInput(page)).toBeFocused();
}

// "Ask from the Pull Requests page sends no worktree; while it starts, Cancel is disabled and Escape does
// nothing" and "a failed pr.ask is toasted and keeps the question for a retry": src/components/pr/PullRequestSurface.test.tsx
// ("Ask from the Pull Requests page", "a failed pr.ask").

test("choosing Ask again with the composer open focuses it; the menu reopened right after Ask stays open", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await openAsk(page);
  await askInput(page).pressSequentially("draft");
  // Focus leaves the composer.
  await page.getByTestId("pr-title").click();
  await expect(askInput(page)).not.toBeFocused();

  await openAsk(page);
  await expect(askInput(page)).toHaveValue("draft");
  // And it stays there once the menu's close has run.
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
  await expect(askInput(page)).toBeFocused();

  // Reopened while the menu is still fading out from choosing Ask: it stays open.
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  await expect(page.getByTestId("pr-menu")).toHaveAttribute("data-state", "open");
  // A later close returns focus to the menu button, as usual.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
  await expect(page.getByTestId("pr-menu-button")).toBeFocused();
  await expect(askInput(page)).toHaveValue("draft");
  // The ⋯ button still closes an open menu.
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toHaveAttribute("data-state", "open");
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
});

// "a pull request's running threads show on every surface that shows it": src/components/pr/PullRequestSurface.test.tsx (same title).

test("at 280px the composer's hint fits and its field grows, then scrolls", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await setPanelWidth(page, 280);
  await openAsk(page);
  expect(await overflowX(page, "pr-ask")).toBeLessThanOrEqual(0);
  expect(await page.getByTestId("pr-ask-hint").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(inside(await boxOf(page, "pr-ask-send"), await boxOf(page, "side-panel"))).toBe(true);

  const size = () => askInput(page).evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
  const three = await size();
  await askInput(page).fill("1\n2\n3\n4\n5");
  const five = await size();
  expect(five.height).toBeGreaterThan(three.height);
  expect(five.scroll).toBeLessThanOrEqual(five.height);
  await askInput(page).fill(Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join("\n"));
  const many = await size();
  // It stops growing, then scrolls.
  expect(many.height).toBeGreaterThanOrEqual(five.height);
  expect(many.scroll).toBeGreaterThan(many.height);
  await askInput(page).fill("short");
  expect((await size()).height).toBe(three.height);
});

/** Resolves once el's open animations (a menu's fade-in) have finished. */
async function settledAnimations(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}

// The merge menu's items, the delete-branch note, the confirmation, pr.merge's args with the head, the
// toast; draft, read-only and merged pull requests; unchecking the branch, declining, the spinner, a
// refusal; a fork's branch: src/components/pr/PullRequestSurface.test.tsx ("the merge button").
test("#142 merges from a menu inside the side panel; the dashboard moves it to recently merged", async ({ page }) => {
  await shotViewport(page);
  await openPrPage(page);
  await prRow(page, "authored", 142).click();
  await page.getByTestId("pr-merge-button").click();
  await expect(page.getByTestId("pr-merge-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-merge-menu"), await boxOf(page, "side-panel"))).toBe(true);
  await settledAnimations(page, "pr-merge-menu");
  await shot(page, "merge-button");

  await page.getByTestId("pr-merge-method-squash").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("pr-state")).toHaveText("Merged");
  // The daemon announces the dashboard change: the row moves to recently merged.
  await expect(prRow(page, "merged", 142)).toBeVisible();
  await expect(prRow(page, "authored", 142)).toHaveCount(0);
});

test("at 280px the merge button keeps its icons and its dropdown stays inside the panel", async ({ page }) => {
  await shotViewport(page);
  await openPrPage(page);
  await prRow(page, "authored", 142).click();
  await setPanelWidth(page, 280);
  const button = page.getByTestId("pr-merge-button");
  await expect(button).toBeVisible();
  expect(await overflowX(page, "pr-header")).toBeLessThanOrEqual(0);
  // The label is for screen readers only; the icon and chevron stay.
  expect((await boxOf(page, "pr-merge-button")).width).toBeLessThan(48);
  await expect(button).toHaveAccessibleName("Merge");
  expect(inside(await boxOf(page, "pr-actions"), await boxOf(page, "pr-header"))).toBe(true);
  await button.click();
  await expect(page.getByTestId("pr-merge-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-merge-menu"), await boxOf(page, "side-panel"))).toBe(true);
  const cut = await page.getByTestId("pr-merge-menu").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(cut).toBeLessThanOrEqual(0);
  await settledAnimations(page, "pr-merge-menu");
  await shot(page, "merge-button-280");
});

// ---- Review ▾ (pr.review; docs/notes/pr-review-submit-2-gui.md) ----------------------

// The Review menu, the composer's label, hint and keys, pr.review's args, the toast, the chip, the
// reviewer entry and the review in Comments: src/components/pr/PullRequestSurface.test.tsx ("Review ▾").
test("Review on #139 sits left of Merge; its menu stays inside the panel", async ({ page }) => {
  await shotViewport(page);
  await openPrPage(page);
  await prRow(page, "review", 139).click();
  await expect(page.getByTestId("pr-review-button")).toHaveText("Review");
  expect((await boxOf(page, "pr-review-button")).x).toBeLessThan((await boxOf(page, "pr-merge-button")).x);
  await page.getByTestId("pr-review-button").click();
  await expect(page.getByTestId("pr-review-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-review-menu"), await boxOf(page, "side-panel"))).toBe(true);
  await settledAnimations(page, "pr-review-menu");
  await shot(page, "review-menu");
  if (!shots) return;

  // The composer and the approved header, for the PR body.
  await page.getByTestId("pr-review-approve").click();
  await page.getByTestId("pr-review-input").pressSequentially("Read it through.");
  await shot(page, "review-approve");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByTestId("pr-your-review")).toHaveText("You approved");
  await page.mouse.move(0, 0);
  await shot(page, "review-approved");
});

// "Review composer: Request changes waits for text, verdicts switch keeping it, Escape cancels, one
// composer at a time", "a review GitHub did not confirm is toasted and keeps the text; the same text gets
// that answer again; while it runs the field is read-only", "#145 (the viewer's own): Approve and Request
// changes are disabled with the reason; Comment posts a review; #140 and #138 have no Review" and "the
// review composer closes when the pull request stops taking reviews (merged meanwhile)": src/components/pr/PullRequestSurface.test.tsx
// ("Review ▾"). The same text getting the same answer for 2 minutes is the daemon's
// (internal/store/gh/pr_review_test.go).
