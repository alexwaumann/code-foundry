import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, resetMock, row } from "./fixtures";
import { layoutState, paneNode, paneOf, rowNode, threadTab } from "./shell";
import { openLayout, openPrBesidePage, openPrBesideThread, PR_PANE, prTab, showPr, sizePane, SLUG, tabIn } from "./shell-pages";

/**
 * The Pull request surface in a pull request's tab, beside the Pull Requests page in a pane sized
 * to the width measured at (shell-pages.ts), against the mock daemon's fixtures
 * (mock/prDetail.ts): #145 open with failing checks, threads, labels and reviewers;
 * #138 merged and revertable; #131 closed; #140 read-only; #142 mergeable; #146 from a
 * fork; #139 a teammate's, awaiting the viewer's review; #160-#164 the readiness box's
 * other states. Set SHOTS=<dir> to save screenshots.
 */

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

const prRow = (page: Page, section: string, number: number) => page.getByTestId(`prs-${section}`).locator("[data-nav-key]").filter({ hasText: `#${String(number)}` });

/** The pane the pull request is in. */
const PANE = "pr-pane";
async function paneBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await paneOf(page, PR_PANE).boundingBox();
  if (!b) throw new Error("the pull request's pane has no box");
  return b;
}

/** How far an element's content overflows it horizontally (0 or less: it fits). */
function overflowX(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);
}

async function boxOf(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  if (testId === PANE) return paneBox(page);
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

// "a row on the Pull Requests page opens #145: header, readiness box, reviewers, …": src/components/pr/PullRequestSurface.test.tsx ("#145: header, readiness box, ...").
// The readiness model: src/components/pr/readiness.test.ts.
test("overview (screenshot)", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshot is all it adds");
  await openPrBesidePage(page, 145);
  await expect(page.getByTestId("pr-ready-headline")).toHaveText("Not ready to merge4 left");
  await shot(page, "chunk3-summary");
});

/** No element of the readiness box sticks out of it, and no two of a row's or the footer's parts overlap. */
async function boxFits(page: Page): Promise<void> {
  const problems = await page.getByTestId("pr-surface").evaluate((surface) => {
    const out: string[] = [];
    const r = (e: Element) => e.getBoundingClientRect();
    const within = (a: DOMRect, b: DOMRect) => a.left >= b.left - 1 && a.right <= b.right + 1;
    const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const sr = r(surface);
    for (const id of ["pr-header", "pr-readiness", "pr-inner-bar", "pr-overview"]) {
      const el = surface.querySelector(`[data-testid="${id}"]`);
      if (!el) continue;
      if (el.scrollWidth > el.clientWidth) out.push(`${id} overflows by ${String(el.scrollWidth - el.clientWidth)}`);
      if (!within(r(el), sr)) out.push(`${id} outside the surface`);
    }
    const box = surface.querySelector('[data-testid="pr-readiness"]');
    if (!box) return ["no box"];
    const br = r(box);
    for (const el of box.querySelectorAll("button, [data-testid=pr-ready-title], [data-testid=pr-ready-lines]")) if (!within(r(el), br)) out.push(`${el.textContent} outside the box`);
    const footer = box.querySelector('[data-testid="pr-ready-footer"]');
    const parts = footer ? [...footer.querySelectorAll("button")] : [];
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (overlap(r(parts[i] as Element), r(parts[j] as Element))) out.push(`footer: ${parts[i]?.textContent ?? ""} overlaps ${parts[j]?.textContent ?? ""}`);
    // A row's button sits under its text, never beside or over it.
    for (const row of box.querySelectorAll('[data-testid="pr-ready-row"]')) {
      const title = row.querySelector('[data-testid="pr-ready-title"]');
      for (const b of row.querySelectorAll("[data-slot=button], [data-testid^=pr-task-]")) if (title && r(b).top < r(title).bottom - 1) out.push(`${b.textContent} is not under its row's text`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}

// Which rows, headline and footer each state has: src/components/pr/readiness.test.ts; the buttons per
// state and viewer: src/components/pr/PullRequestSurface.test.tsx ("the readiness box and the Overview", "the merge button", "auto-merge").
test("the readiness box fits at 360, 420 and 560px in every state: nothing overflows or overlaps, actions under their row's text", async ({ page }) => {
  await openPrBesidePage(page, 145);
  for (const width of [360, 420, 560]) {
    await sizePane(page, PR_PANE, width);
    for (const n of [145, 160, 161, 162, 163, 164, 142, 139, 140, 131, 138]) {
      await showPr(page, n);
      await expect(page.getByTestId("pr-ready-headline")).toBeVisible();
      await boxFits(page);
    }
  }
});

// Which controls the Code tab's compact box keeps: src/components/pr/PullRequestSurface.test.tsx ("the Code tab keeps ...").
test("the Code tab's compact box: headline and footer on one line when the panel is wide enough, under it when not; the diff keeps the height", async ({ page }) => {
  // #145 as s-3's linked tab.
  await openPrBesideThread(page, "s-3", 145);
  await page.getByTestId("pr-tab-code").click();
  await expect(page.getByTestId("pr-readiness")).toHaveAttribute("data-compact", "true");
  for (const [width, oneLine] of [
    [560, true],
    [420, false],
    [360, false],
  ] as const) {
    await sizePane(page, PR_PANE, width);
    await boxFits(page);
    const head = await boxOf(page, "pr-ready-headline");
    const foot = await boxOf(page, "pr-ready-footer");
    // One line: the controls sit beside the headline; else under it.
    expect(foot.y < head.y + head.height).toBe(oneLine);
    // At the 800px window the box stays small and the diff (the strip down to the pane's foot) has most of the pane.
    expect((await boxOf(page, "pr-readiness")).height).toBeLessThanOrEqual(oneLine ? 44 : 72);
    const pane = await boxOf(page, PANE);
    expect(pane.y + pane.height - (await boxOf(page, "pr-code-strip")).y).toBeGreaterThan(pane.height / 2);
  }
});

// Timeline's entries, order, commit links and inner tabs per panel tab: src/components/pr/PullRequestSurface.test.tsx ("Timeline").
test("Timeline at the default 420px: the counts end before the order toggle; the rail stops at the last entry's icon", async ({ page }) => {
  await openPrBesidePage(page, 145, 420);
  await page.getByTestId("pr-tab-activity").click();
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
  await openPrBesidePage(page, 145);
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
  // A reviewer is an avatar (its login in data-login and its label, no text).
  await expect(page.locator('[data-testid="pr-reviewer"][data-login="teammate-lee"]')).toHaveCount(1);
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

test("an unlinked pull request tab keeps its Code tab across a resize of its pane", async ({ page }) => {
  await openPrBesidePage(page, 145);
  await page.getByTestId("pr-tab-code").click();
  await expect(page.getByTestId("pr-tab-code")).toHaveAttribute("aria-selected", "true");
  await sizePane(page, PR_PANE, 500);
  await expect(page.getByTestId("pr-tab-code")).toHaveAttribute("aria-selected", "true");
});

// The menu's items, Refresh (and a failed one), Open on GitHub and Copy link: src/components/pr/PullRequestSurface.test.tsx ("the ⋯ menu").
test("shift+cmd+c copies the link while the panel has focus", async ({ page }) => {
  await openPrBesidePage(page, 145);
  await page.getByTestId("pr-title").click();
  await page.keyboard.press("Meta+Shift+c");
  await expect.poll(() => copied(page)).toEqual([`https://github.com/${SLUG}/pull/145`]);
  await expect(page.getByText("Link copied")).toBeVisible();
});

// "#138 (merged) offers Revert", "declining the revert's confirmation sends nothing" and "#140 (read
// access) explains the picker and has no revert; #131 is closed; unknown numbers say not found":
// src/components/pr/PullRequestSurface.test.tsx ("the ⋯ menu", "Overview").
test("merged pull request menu (screenshot)", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshot is all it adds");
  await openPrBesidePage(page, 138);
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu-revert")).toBeVisible();
  await shot(page, "chunk3-menu");
});

/** SHOTS=<dir>: each action while it runs, dark and light. The states themselves: PullRequestSurface.test.tsx ("busy feedback"). */
for (const scheme of ["dark", "light"] as const) {
  test(`Ready for review busy (screenshot, ${scheme})`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await shotViewport(page);
    await openPrBesidePage(page, 145);
    const ready = page.getByTestId("pr-ready-for-review");
    await expect(ready).toHaveText("Ready for review");
    await mockPost("gh/pr-detail-delay?ms=30000");
    await ready.click();
    await expect(ready).toHaveText("Marking ready…");
    await page.mouse.move(5, 5);
    await shot(page, `busy-ready-${scheme}`);
  });

  test(`Convert to draft busy (screenshot, ${scheme})`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await shotViewport(page);
    await openPrBesidePage(page, 142);
    await expect(page.getByTestId("pr-menu-button")).toBeVisible();
    await mockPost("gh/pr-detail-delay?ms=30000");
    await page.getByTestId("pr-menu-button").click();
    await page.getByTestId("pr-menu-draft").click();
    await expect(page.getByTestId("pr-menu-draft")).toContainText("Converting to draft…");
    await shot(page, `busy-draft-${scheme}`);
  });

  test(`Cancel auto-merge busy (screenshot, ${scheme})`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await shotViewport(page);
    await openPrBesidePage(page, 164);
    const cancel = page.getByTestId("pr-cancel-auto-merge");
    await expect(cancel).toHaveText("Cancel auto-merge");
    await mockPost("gh/pr-detail-delay?ms=30000");
    await cancel.click();
    await expect(cancel).toHaveText("Cancelling…");
    await page.mouse.move(5, 5);
    await shot(page, `busy-cancel-${scheme}`);
  });

  test(`Revert busy (screenshot, ${scheme})`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await shotViewport(page);
    await openPrBesidePage(page, 138);
    await mockPost("gh/pr-delay?ms=30000");
    const revert = page.getByTestId("pr-revert");
    await revert.click();
    await page.getByTestId("confirm-ok").click();
    await expect(revert).toHaveText("Reverting…");
    await page.mouse.move(5, 5);
    await shot(page, `busy-revert-${scheme}`);
  });
}

// "panel state is per selection; a thread or worktree on a PR branch enables the surface": the side
// panel per selection is gone (a pull request is a tab); which pull requests a thread's + submenu
// offers: src/components/shell/linkedTabs.test.tsx ("lists a diff per checkout and every linked pull request").

test("light scheme", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only: the screenshot is all it adds");
  await page.emulateMedia({ colorScheme: "light" });
  await openPrBesidePage(page, 145);
  await expect(page.getByTestId("pr-ready-headline")).toHaveText("Not ready to merge4 left");
  await shot(page, "chunk3-light-summary");
});

// Closing a tab drops its inner state (reopened, it starts on Overview): src/components/pr/PullRequestSurface.test.tsx ("closing a tab drops its inner state").
test("cmd+w from inside the surface closes its tab; the last tab gone, the panel hides", async ({ page }) => {
  await openPrBesidePage(page, 145);
  await expect(paneOf(page, PR_PANE).getByTestId("shell-tab")).toHaveCount(1);
  await page.getByTestId("pr-title").click();
  await page.keyboard.press("Meta+w");
  // Its pane goes with its last tab; the page's pane takes the grid.
  await expect(paneOf(page, PR_PANE)).toHaveCount(0);
  await expect(page.getByTestId("pr-surface")).toHaveCount(0);
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);
  await expect.poll(async () => (await layoutState()).spaces[0]?.root?.t).toBe("pane");
});

test("at 280px nothing overflows: header, readiness box, inner tab bar, logins, popups; the active tab is revealed", async ({ page }) => {
  await openPrBesidePage(page, 145, 280);
  await expect(page.getByTestId("pr-surface")).toBeVisible();

  // Overview: the header, the box (its footer wraps) and the bar fit.
  expect(await overflowX(page, "pr-header")).toBeLessThanOrEqual(0);
  expect(await overflowX(page, "pr-inner-bar")).toBeLessThanOrEqual(0);
  await boxFits(page);
  expect(inside(await boxOf(page, "pr-diffstat"), await boxOf(page, "pr-header"))).toBe(true);
  expect(inside(await boxOf(page, "pr-reviewers"), await boxOf(page, PANE))).toBe(true);
  // Comment authors are not cut before their verdict.
  const cutComments = await page.getByTestId("pr-comment-author").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cutComments).toEqual([]);

  // Timeline: the counts give way; the order toggle stays reachable.
  await page.getByTestId("pr-tab-activity").click();
  expect(await overflowX(page, "pr-inner-bar")).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("pr-timeline-counts")).toBeHidden();
  expect(inside(await boxOf(page, "pr-timeline-order"), await boxOf(page, "pr-inner-bar"))).toBe(true);
  const cut = await page.getByTestId("pr-timeline-author").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cut).toEqual([]);
  await page.getByTestId("pr-timeline-order").click();
  await expect(page.getByTestId("pr-timeline")).toHaveAttribute("data-order", "oldest");

  // The popups and the Review composer reached through one: the next test.
  // The side panel's strip scrolling its active tab into view is gone: a pane's strip fits its tabs,
  // going icon-only when tight (src/components/shell/PaneTabStrip.test.tsx, "tight, tabs go icon-only").
});

test("at 280px the surface's popups stay inside its pane: the ⋯ menu, the reviewer picker, the Review menu and its composer", async ({ page }) => {
  await openPrBesidePage(page, 145, 280);
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-menu"), await boxOf(page, PANE))).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByTestId("pr-add-reviewer").click();
  await expect(page.getByTestId("pr-reviewer-picker")).toBeVisible();
  expect(inside(await boxOf(page, "pr-reviewer-picker"), await boxOf(page, PANE))).toBe(true);
  await page.keyboard.press("Escape");
  // Gone (its exit animation over): closing hands focus back to its button.
  await expect(page.getByTestId("pr-reviewer-picker")).toHaveCount(0);
  await expect(page.getByTestId("pr-review-button")).toHaveAccessibleName("Review");
  await page.getByTestId("pr-review-button").click();
  await expect(page.getByTestId("pr-review-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-review-menu"), await boxOf(page, PANE))).toBe(true);
  await page.getByTestId("pr-review-comment").click();
  expect(await overflowX(page, "pr-review-composer")).toBeLessThanOrEqual(0);
  expect(inside(await boxOf(page, "pr-review-submit"), await boxOf(page, PANE))).toBe(true);
  await expect(page.getByTestId("pr-review-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-review-composer")).toHaveCount(0);
});

test("long conversations and timelines are virtualized in the panel's scroll", async ({ page }) => {
  for (let i = 1; i <= 45; i++) await mockPost(`gh/pr-comment?number=145&body=${encodeURIComponent(`Note ${String(i)}`)}`);
  await openPrBesidePage(page, 145);
  const list = page.getByTestId("pr-comments-list");
  await expect(list).toHaveAttribute("data-virtual", "true");
  await expect(page.getByTestId("pr-comments")).toContainText("Comments(54)");
  expect(await page.getByTestId("pr-comment").count()).toBeLessThan(50);
  // Scrolled to the end, the oldest item (the outdated thread) is mounted and visible. The scroll is
  // the surface's own, in its pane.
  const body = paneOf(page, PR_PANE).locator("[data-pr-scroll]");
  await list.evaluate((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) {
        p.setAttribute("data-pr-scroll", "");
        return;
      }
    }
    throw new Error("the surface does not scroll");
  });
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
  await page.getByTestId("pr-tab-activity").click();
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
  await openPrBesidePage(page, 145);
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  // Let the menu's fade-in finish before the screenshot.
  await page.getByTestId("pr-menu").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await shot(page, "chunk4-menu");

  await page.getByTestId("pr-menu-explain").click();
  // The daemon's FocusThread opens the new thread's tab in the focused pane and selects its row.
  await expect(selectedThread(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  const id = String(await selectedThread(page).getAttribute("data-row-key")).slice(2);
  await expect(page.locator(`[data-testid="thread-pane"][data-thread-id="${id}"]`)).toBeVisible();

  // The pull request's tab stays where it was: back on it, #145 (menu closed).
  await tabIn(page, PR_PANE, "t-pr-145").locator('[role="tab"]').click();
  await expect(page.getByTestId("pr-title")).toContainText("resize race");
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
});

// The composer under the header, Escape into the panel, Shift+Enter, Enter sending pr.ask with the
// thread's worktree in the context: src/components/pr/PullRequestSurface.test.tsx ("Ask a question from a thread").
test("Ask from a thread's panel selects the new thread; back on that thread its panel keeps #145 without the composer", async ({ page }) => {
  await shotViewport(page);
  // s-1 with #145 as its linked tab beside it.
  await openLayout(page, rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode(PR_PANE, [prTab(145, "s-1")])], [0.55, 0.45]), PR_PANE);
  await expect(page.getByTestId("pr-surface")).toHaveAttribute("data-pr", `${SLUG}#145`);
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  const input = page.getByTestId("pr-ask-input");
  await expect(input).toBeFocused();
  await input.pressSequentially("Why does attach race the first output?");
  await shot(page, "chunk4-ask");
  await page.keyboard.press("Enter");
  await expect(selectedThread(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  expect((await threadInvocations("pr.ask")).map((i) => i.worktree)).toEqual([CF]);

  // Back on s-1 and its pull request's tab: #145, without the composer.
  await row(page, "s:s-1").click();
  await tabIn(page, PR_PANE, "t-pr-145").locator('[role="tab"]').click();
  await expect(page.getByTestId("pr-title")).toContainText("resize race");
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
  await openPrBesidePage(page, 145);
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
  await openPrBesidePage(page, 145, 280);
  await openAsk(page);
  expect(await overflowX(page, "pr-ask")).toBeLessThanOrEqual(0);
  expect(await page.getByTestId("pr-ask-hint").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(inside(await boxOf(page, "pr-ask-send"), await boxOf(page, PANE))).toBe(true);

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
  await openPrBesidePage(page, 142);
  await page.getByTestId("pr-merge-button-menu-button").click();
  await expect(page.getByTestId("pr-merge-button-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-merge-button-menu"), await boxOf(page, PANE))).toBe(true);
  await settledAnimations(page, "pr-merge-button-menu");
  await shot(page, "merge-button");

  await page.getByTestId("pr-merge-method-squash").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("pr-state")).toHaveText("Merged");
  // The daemon announces the dashboard change: the row moves to recently merged.
  await expect(prRow(page, "merged", 142)).toBeVisible();
  await expect(prRow(page, "authored", 142)).toHaveCount(0);
});

test("at 280px the merge split button stays inside the box and its dropdown inside the panel", async ({ page }) => {
  await shotViewport(page);
  await openPrBesidePage(page, 142, 280);
  await expect(page.getByTestId("pr-merge-button")).toBeVisible();
  await boxFits(page);
  expect(inside(await boxOf(page, "pr-merge-button-split"), await boxOf(page, "pr-readiness"))).toBe(true);
  await page.getByTestId("pr-merge-button-menu-button").click();
  await expect(page.getByTestId("pr-merge-button-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-merge-button-menu"), await boxOf(page, PANE))).toBe(true);
  const cut = await page.getByTestId("pr-merge-button-menu").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(cut).toBeLessThanOrEqual(0);
  await settledAnimations(page, "pr-merge-button-menu");
  await shot(page, "merge-button-280");
});

// ---- Review ▾ (pr.review; docs/notes/pr-review-submit-2-gui.md) ----------------------

// The Review menu, the composer's label, hint and keys, pr.review's args, the toast, the chip, the
// reviewer entry and the review in Comments: src/components/pr/PullRequestSurface.test.tsx ("Review ▾").
test("Review on #139 sits left of Auto-merge in the box's footer; its menu stays inside the panel", async ({ page }) => {
  await shotViewport(page);
  await openPrBesidePage(page, 139);
  await expect(page.getByTestId("pr-review-button")).toHaveText("Review");
  expect((await boxOf(page, "pr-review-button")).x).toBeLessThan((await boxOf(page, "pr-auto-merge-button")).x);
  await page.getByTestId("pr-review-button").click();
  await expect(page.getByTestId("pr-review-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-review-menu"), await boxOf(page, PANE))).toBe(true);
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
