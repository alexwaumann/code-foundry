import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openThreadChanges, resetMock, row, setZoom } from "./fixtures";

/**
 * A long file (over 400 lines: the library's virtualizer) under page zoom
 * (docs/notes/file-edit-zoom.md, "The virtualizer under zoom"): which rows are rendered, and
 * where the scroll lands, is geometry only a browser has. Set SHOTS=<dir> to save the pull
 * request's screenshots.
 */

const shots = process.env.SHOTS;
const file = (page: Page) => page.getByTestId("file-tab");
const N = 1200;
// Short rows keep the mock's write in one URL (spaces as "+"); every 100th wraps when wrap is on.
const TEXT = Array.from({ length: N }, (_, i) => (i % 100 === 50 ? `${String(i + 1)} ${"wraps ".repeat(60)}` : String(i + 1))).join("\n");

async function openLong(page: Page, line?: number): Promise<void> {
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/long.txt`)}&text=${encodeURIComponent(TEXT).replaceAll("%20", "+")}`);
  await row(page, "s:s-1").click();
  await openThreadChanges(page);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: "long.txt", ...(line ? { line } : {}) })}))`);
  await expect(file(page).getByTestId("file-code")).toHaveAttribute("data-virtual", "");
}

interface View {
  /** The lines whose rows are on screen, first and last; null when none is. */
  first: number | null;
  last: number | null;
  /** Layout px of the scroller not covered by a row, above the first and below the last. */
  above: number;
  below: number;
  /** Where line `at`'s row starts, as a fraction of the scroller's height; null when not rendered. */
  at: number | null;
}

/** What the scroller shows; with `toEnd` it first scrolls to the end, as a drag of the thumb would. */
async function view(page: Page, opts: { toEnd?: boolean; at?: number } = {}): Promise<View> {
  return file(page)
    .getByTestId("file-code")
    .evaluate((box, { toEnd, at }) => {
      const sc = box.firstElementChild as HTMLElement;
      if (toEnd) sc.scrollTop = sc.scrollHeight;
      const zoom = sc.currentCSSZoom;
      const s = sc.getBoundingClientRect();
      const rows = [...(sc.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]:not([data-column-number])") ?? [])].map((r) => ({ n: Number(r.dataset.line), r: r.getBoundingClientRect() }));
      const shown = rows.filter(({ r }) => r.height > 0 && r.bottom > s.top + 1 && r.top < s.bottom - 1);
      const target = at === undefined ? undefined : rows.find((r) => r.n === at);
      if (shown.length === 0) return { first: null, last: null, above: s.height / zoom, below: s.height / zoom, at: null };
      return {
        first: Math.min(...shown.map((x) => x.n)),
        last: Math.max(...shown.map((x) => x.n)),
        above: Math.max(0, Math.min(...shown.map((x) => x.r.top)) - s.top) / zoom,
        below: Math.max(0, s.bottom - Math.max(...shown.map((x) => x.r.bottom))) / zoom,
        at: target ? Math.round(((target.r.top - s.top) / s.height) * 100) / 100 : null,
      };
    }, opts);
}

/** Scrolled to the end, the last line is on screen with no blank strip under it (only the file's bottom padding). */
async function expectEndShown(page: Page): Promise<void> {
  await expect.poll(async () => view(page, { toEnd: true })).toMatchObject({ last: N, above: 0 });
  expect((await view(page)).below).toBeLessThan(12);
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  // Wide enough that the panel stays open at 200%.
  await page.setViewportSize({ width: 2400, height: 1100 });
  await openApp(page);
});

test("scrolled to the end of a long file, the last line shows at 90% and at 125%, wrapped or not", async ({ page }) => {
  await openLong(page);
  for (const wrap of [false, true]) {
    await page.evaluate(`__cfModule("/src/stores/codeView.ts").then((m) => m.setWrap(${String(wrap)}))`);
    for (const zoom of [90, 125]) {
      await setZoom(page, zoom);
      await expectEndShown(page);
      if (shots && !wrap) await file(page).screenshot({ path: `${shots}/file-end-${String(zoom)}.png` });
    }
  }
});

test("in edit mode at 125% the end of a long file shows, and a zoom change keeps the line on top", async ({ page }) => {
  await openLong(page);
  await page.evaluate(`__cfModule("/src/stores/codeView.ts").then((m) => m.setWrap(true))`);
  await file(page).getByTestId("file-edit").click();
  await expect(file(page).locator('[data-content][contenteditable="true"]')).toBeVisible();
  await setZoom(page, 125);
  await expectEndShown(page);
  if (shots) await file(page).screenshot({ path: `${shots}/file-edit-end-125.png` });

  // Mid-file: the browser's own scroll anchoring moved it tens of lines on a zoom change.
  await file(page)
    .getByTestId("file-code")
    .evaluate((box) => {
      (box.firstElementChild as HTMLElement).scrollTop = 14000;
    });
  await expect.poll(async () => (await view(page)).above).toBe(0);
  const first = (await view(page)).first ?? 0;
  for (const zoom of [90, 200, 100]) {
    await setZoom(page, zoom);
    await expect.poll(async () => (await view(page)).first).toBeGreaterThanOrEqual(first - 1);
    const now = await view(page);
    expect(now.first).toBeLessThanOrEqual(first + 1);
    expect(now.above).toBe(0);
  }
});

test("a long file opened at a line lands it a third down at 200%", async ({ page }) => {
  await setZoom(page, 200);
  await openLong(page, 900);
  await expect.poll(async () => (await view(page, { at: 900 })).at).toBeCloseTo(0.33, 1);
});

test("the Diff tab keeps its top row across zoom changes, wrapped", async ({ page }) => {
  // An untracked file of the thread's checkout: every line added, over 400 rows (the virtualizer).
  const path = "notes/plan.md";
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/${path}`)}&text=${encodeURIComponent(TEXT).replaceAll("%20", "+")}`);
  await row(page, "s:s-1").click();
  await openThreadChanges(page);
  await page.locator(`[data-nav-key="f:${path}"]`).click();
  const code = page.getByTestId("diff-code");
  await expect(code).toHaveAttribute("data-virtual", "");
  await page.evaluate(`__cfModule("/src/stores/codeView.ts").then((m) => m.setWrap(true))`);
  // The first row on screen, by its row index (a diff's line numbers repeat).
  const topRow = () =>
    code.evaluate((box) => {
      const sc = box.firstElementChild as HTMLElement;
      const s = sc.getBoundingClientRect();
      const rows = [...(sc.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [])];
      const shown = rows.find((r) => {
        const b = r.getBoundingClientRect();
        return b.height > 0 && b.bottom > s.top + 1 && b.top < s.bottom - 1;
      });
      return Number((shown?.dataset.lineIndex ?? "").split(",")[0]);
    });
  await code.evaluate((box) => {
    (box.firstElementChild as HTMLElement).scrollTop = 14000;
  });
  await expect.poll(topRow).toBeGreaterThan(0);
  const first = await topRow();
  for (const zoom of [90, 200, 100]) {
    await setZoom(page, zoom);
    await expect.poll(topRow).toBe(first);
  }
});
