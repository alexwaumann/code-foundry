import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, mockUrl, resetMock, setZoom } from "./fixtures";
import { openPrBesidePage, PR_PANE, sizePane } from "./shell-pages";

/**
 * The Pull request surface's Code tab against the mock's three-file diff (mock/prDiff.ts), in a
 * pull request's tab beside the Pull Requests page:
 * a renamed note, an added binary, a modified TypeScript file with four hunks. The diff
 * lives in the library's shadow roots; Playwright's CSS locators pierce them. Set
 * SHOTS=<dir> to save screenshots.
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

async function ghCalls(): Promise<Record<string, number>> {
  const res = await fetch(`${mockUrl}/__mock/gh/calls`);
  return (await res.json()) as Record<string, number>;
}

/**
 * Clicks an element of the diff where it is on screen, once it takes pointer events: the
 * library turns them off while it scrolls, and Playwright's own scrolling into view can
 * leave the element under a sticky file header.
 */
async function clickInDiff(page: Page, target: Locator): Promise<void> {
  await target.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
  const hit = () =>
    target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      let at: Element | null = document.elementFromPoint(x, y);
      while (at?.shadowRoot) {
        const inner = at.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === at) break;
        at = inner;
      }
      return at !== null && el.contains(at) ? { x, y } : null;
    });
  await expect.poll(hit).not.toBeNull();
  const p = await hit();
  if (!p) throw new Error("the element takes no clicks");
  await page.mouse.click(p.x, p.y);
}

async function openCode(page: Page, number: number): Promise<void> {
  await openPrBesidePage(page, number);
  await page.getByTestId("pr-tab-code").click();
}

const diff = (page: Page) => page.getByTestId("pr-code-diff");
const header = (page: Page, path: string) => diff(page).locator(`[data-testid="pr-code-header"][data-path="${path}"]`);

test("the Code tab lists the files and renders the diff; split, file rows scroll, hunks expand", async ({ page }) => {
  await openCode(page, 145);
  await expect(page.getByTestId("pr-code-totals")).toHaveText("3 files · +7 −5");
  const rows = page.getByTestId("pr-code-file");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator("[data-status]")).toHaveText(["R", "A", "M"]);
  await expect(rows.nth(0)).toHaveAttribute("data-path", "docs/notes/welcome-greeting.md");
  await expect(rows.nth(1)).toContainText("bin");

  // Every file is an item of one CodeView under its own sticky header; the binary one is folded.
  await expect(diff(page).locator("[data-line-type='change-addition']").first()).toBeVisible();
  await expect(header(page, "docs/notes/welcome-greeting.md")).toBeVisible();
  await expect(header(page, "gui/frontend/public/logo.png")).toContainText("binary");
  await expect(header(page, "gui/frontend/public/logo.png")).toHaveAttribute("data-collapsed", "true");
  // (StrictMode's double mount can read it twice in development.)
  expect((await ghCalls()).GetPullRequestDiff).toBeGreaterThanOrEqual(1);
  if (shots) await page.screenshot({ path: `${shots}/pr-code-unified.png` });

  // Unified | Split is the codeView store's, so it applies to every file at once.
  await expect(diff(page).locator("pre[data-diff-type='single']").first()).toBeVisible();
  await page.getByTestId("pr-code-style-split").click();
  await expect(page.getByTestId("pr-code-style-split")).toHaveAttribute("aria-checked", "true");
  await expect(diff(page).locator("pre[data-diff-type='split']").first()).toBeVisible();
  await expect(diff(page).locator("pre[data-diff-type='single']")).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/pr-code-split.png` });
  await page.getByTestId("pr-code-style-unified").click();

  // A row scrolls its file's header to the top of the diff.
  const ts = "gui/frontend/src/lib/greeting.ts";
  await page.locator(`[data-testid="pr-code-file"][data-path="${ts}"]`).click();
  await expect
    .poll(async () => {
      const box = await diff(page).boundingBox();
      const h = await header(page, ts).boundingBox();
      return box && h ? Math.round(h.y - box.y) : null;
    })
    .toBeLessThan(4);

  // Expanding unchanged lines reads the head copy once (the old side is rebuilt from it).
  const file = diff(page).locator("diffs-container").filter({ has: page.locator(`[data-testid="pr-code-header"][data-path="${ts}"]`) });
  await clickInDiff(page, file.locator("[data-expand-button]").first());
  await expect.poll(async () => (await ghCalls())[`GetPullRequestFile ${ts}`]).toBe(1);
  await expect(file.locator("[data-line-type='context-expanded']").first()).toBeVisible();
  if (shots) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/pr-code-expanded.png` });
  }
});

// "the file list folds; the diff is read again when the head moves and on refresh" and "a diff GitHub
// refuses as too large shows its message and the way to GitHub": src/components/pr/PrCode.test.tsx.

test("the Code tab keeps its top row across zoom changes and a resize of its pane, wrapped", async ({ page }) => {
  // The library's CodeView anchors its own scroll on a re-layout (docs/notes/shell-24c-last-pass.md):
  // a long added file whose every 100th line wraps, so rows above the top change height.
  await page.setViewportSize({ width: 2400, height: 1100 });
  await mockPost("gh/pr-diff-long?number=145");
  await openCode(page, 145);
  await page.evaluate(`__cfModule("/src/stores/codeView.ts").then((m) => m.setWrap(true))`);
  /** The first row on screen: its text (the long file's lines are unique) and how far above the top it starts, in layout px. */
  const top = () =>
    diff(page).evaluate((box) => {
      const sc = box.firstElementChild as HTMLElement;
      const s = sc.getBoundingClientRect();
      let best: { text: string; off: number } | null = null;
      for (const c of sc.querySelectorAll("diffs-container")) {
        for (const r of c.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? []) {
          const b = r.getBoundingClientRect();
          if (b.height > 0 && b.bottom > s.top + 1 && b.top < s.bottom - 1 && (!best || (b.top - s.top) / sc.currentCSSZoom < best.off)) best = { text: (r.textContent ?? "").split(" ")[1] ?? "", off: (b.top - s.top) / sc.currentCSSZoom };
        }
      }
      return best;
    });
  // Line 655 near the top, under the wrapped 651.
  await diff(page).evaluate((box) => {
    (box.firstElementChild as HTMLElement).scrollTop = 13616;
  });
  await expect.poll(async () => (await top())?.text ?? "").toMatch(/^6\d\d$/);
  const first = await top();
  const same = async () => {
    const now = await top();
    return now?.text === first?.text && Math.abs((now?.off ?? 99) - (first?.off ?? 0)) <= 4;
  };
  for (const zoom of [90, 200, 100]) {
    await setZoom(page, zoom);
    await expect.poll(same).toBe(true);
  }
  for (const width of [520, 900]) {
    await sizePane(page, PR_PANE, width);
    await expect.poll(same).toBe(true);
  }
});
