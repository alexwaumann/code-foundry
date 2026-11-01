import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Path chips (docs/notes/file-viewer-4-chips.md) on the mock daemon's idle thread (s-r1,
 * checkout CF): the last answer's prose and inline-code paths open the File tab, and a Write
 * row's path opens its file while the rest of the row still toggles. SHOTS=<dir> saves
 * screenshots.
 */

const pane = (page: Page) => page.getByTestId("thread-pane");
const file = (page: Page) => page.getByTestId("file-tab");
const answer = (page: Page) => pane(page).locator('[data-testid="thread-text"]').last();

/** Wheels the timeline by `dy` steps until `target` is inside it. */
async function wheelTo(page: Page, target: Locator, dy: number): Promise<void> {
  const box = await page.getByTestId("thread-timeline").boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + 200, box.y + 200);
  for (let i = 0; i < 40; i++) {
    const t = (await target.count()) > 0 ? await target.boundingBox() : null;
    if (t && t.y >= box.y && t.y + t.height <= box.y + box.height) return;
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(50);
  }
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(answer(page)).toContainText("All 412 tests pass");
});

// An answer's paths as chips opening the File tab at their line, relative to the thread's
// checkout, by click and by Enter: unit-tested in src/components/thread/timeline.test.tsx and
// rows.test.tsx; the File tab opened at a line (its line selected): e2e/file-tabs.spec.ts; one tab
// per file: src/stores/filePanel.test.ts.
test("the answer's chips (screenshot)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  await expect(answer(page).getByTestId("path-chip")).toHaveText(["README.md", "src/app.ts:12"]);
  await answer(page).screenshot({ path: `${String(process.env.SHOTS)}/chips-answer.png` });
  await answer(page).getByTestId("path-chip").nth(1).click();
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/src/app.ts`);
  await page.screenshot({ path: `${String(process.env.SHOTS)}/chips-file-tab.png` });
});

// A tool row's path opening its file while the rest of the row still toggles: src/components/thread/rows.test.tsx
// ("an Edit row's path opens the file at its first change…"); a chip opening the File tab is the test above.
// This keeps the tool row's screenshot.
test("a Write row's path opens its file; the rest of the row still expands it", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  // Turn 1 is folded on return, above the viewport (the list sits at the bottom): the
  // wheel scrolls up to it (the user's scroll unpins the list), then down to the row.
  const header = pane(page).getByTestId("thread-turn-header").first();
  await wheelTo(page, header, -200);
  await header.locator("button.fold").click();
  const read = pane(page).locator('[data-tool="Write"]').first();
  await wheelTo(page, read, 200);
  const toggle = read.getByTestId("thread-tool");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await read.getByTestId("tool-path-chip").click();
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/internal/store/pr/fingerprint_test.go`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click({ position: { x: 8, y: 8 } });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/chips-tool-row.png` });
});
