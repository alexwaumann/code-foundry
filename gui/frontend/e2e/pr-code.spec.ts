import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock } from "./fixtures";

/**
 * The Pull request surface's Code tab against the mock's three-file diff (mock/prDiff.ts):
 * a renamed note, an added binary, a modified TypeScript file with four hunks. The diff
 * lives in the library's shadow roots; Playwright's CSS locators pierce them. Set
 * SHOTS=<dir> to save screenshots.
 */

const SLUG = "alexwaumann/code-foundry";
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
  await openApp(page);
  // The Pull Requests page is a selection whose panel can hold a pull request.
  await page.getByTestId("nav-pullrequests").click();
  await expect(page.getByTestId("prs-list")).toBeFocused();
  await page.evaluate(`__cfModule("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(number)} }))`);
  await expect(page.getByTestId("pr-surface")).toBeVisible();
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
  await expect(page.getByTestId("pr-code-style-split")).toHaveAttribute("aria-pressed", "true");
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

test("the file list folds; the diff is read again when the head moves and on refresh", async ({ page }) => {
  await openCode(page, 145);
  await expect(page.getByTestId("pr-code-file")).toHaveCount(3);
  await page.getByTestId("pr-code-files-toggle").click();
  await expect(page.getByTestId("pr-code-files")).toHaveCount(0);
  await page.getByTestId("pr-code-files-toggle").click();
  await expect(page.getByTestId("pr-code-file")).toHaveCount(3);

  const reads = (await ghCalls()).GetPullRequestDiff ?? 0;
  await mockPost(`gh/pr-push?repo=${SLUG}&number=145&sha=${"c0de".padEnd(40, "0")}`);
  await expect.poll(async () => (await ghCalls()).GetPullRequestDiff).toBe(reads + 1);

  await page.getByTestId("pr-code-refresh").click();
  await expect.poll(async () => (await ghCalls())["GetPullRequestDiff refresh"]).toBe(1);
  await expect(page.getByTestId("pr-code-file")).toHaveCount(3);
});

test("a diff GitHub refuses as too large shows its message and the way to GitHub", async ({ page }) => {
  await openCode(page, 140);
  const notice = page.getByTestId("pr-code-too-large");
  await expect(notice).toContainText("exceeded the maximum number of files");
  await expect(page.getByTestId("pr-code-diff")).toHaveCount(0);
  await notice.getByTestId("pr-code-too-large-open").click();
  await expect
    .poll(async () => {
      const res = await fetch(`${mockUrl}/__mock/invocations`);
      const all = (await res.json()) as { name: string; args: Record<string, string> }[];
      return all.filter((i) => i.name === "view.open.url").at(-1)?.args.url;
    })
    .toBe(`https://github.com/${SLUG}/pull/140/files`);
});
