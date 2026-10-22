import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Inline pages (code-foundry view.inline; docs/notes/inline-html.md) over the mock's
 * scripted thread in its "html" state (mock/thread.ts): a working turn showing
 * docs/hello.html (themed, asks for its height with cf:resize) and docs/gone.html (missing).
 * SHOTS=<dir> saves screenshots of the live and expanded block in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

const items = (page: Page) => page.getByTestId("thread-html");
const hello = (page: Page) => items(page).filter({ hasText: "hello.html" });
const gone = (page: Page) => items(page).filter({ hasText: "gone.html" });

const shots = process.env.SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.getByTestId("thread-pane").screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

async function openHtmlThread(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=html");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(items(page)).toHaveCount(2);
}

test("an inline page renders in its card, follows cf:resize, and its frame runs scripts", async ({ page }) => {
  await openHtmlThread(page);
  const card = hello(page).getByTestId("thread-html-card");
  await expect(hello(page).getByTestId("thread-html-row")).toHaveAttribute("aria-expanded", "true");
  await expect(hello(page).getByTestId("thread-html-row")).toContainText("Showed hello.html docs");
  await expect(card.getByTestId("thread-html-path")).toHaveText("docs/hello.html");
  const frame = card.getByTestId("thread-html-frame");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  const doc = card.frameLocator('[data-testid="thread-html-frame"]');
  await expect(doc.locator("#hello")).toHaveText("Hello");
  await doc.locator("#wave").click();
  await expect(doc.locator("#hello")).toHaveText("Hello x1");
  // The page asked for its own height (a short page): smaller than the 420px default.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeLessThan(300);
  // The page paints with the published theme (/cf/theme.css), not the frame's white.
  const bg = await doc.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
  // Save is there for the final layout but disabled, with its tooltip.
  const save = card.getByTestId("thread-html-save");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expectTooltip(page, save, "Artifacts come in a later release");
  await shot(page, "inline-html-live");
});

test("source swaps the frame for the file's code, and back", async ({ page }) => {
  await openHtmlThread(page);
  const card = hello(page).getByTestId("thread-html-card");
  await card.getByTestId("thread-html-source-toggle").click();
  await expect(card.getByTestId("thread-html-frame")).toHaveCount(0);
  await expect(card.getByTestId("thread-html-source").locator('[data-line="1"]').first()).toBeVisible();
  await expect(card.getByTestId("thread-html-source-toggle")).toHaveAttribute("aria-pressed", "true");
  await card.getByTestId("thread-html-source-toggle").click();
  await expect(card.getByTestId("thread-html-source")).toHaveCount(0);
  await expect(card.getByTestId("thread-html-frame")).toBeVisible();
});

test("expand shows the page over the pane; Esc closes it and its frame goes", async ({ page }) => {
  await openHtmlThread(page);
  const card = hello(page).getByTestId("thread-html-card");
  await card.getByTestId("thread-html-expand").click();
  const box = page.getByTestId("thread-html-lightbox");
  await expect(box).toBeVisible();
  await expect(box.getByTestId("thread-html-path")).toHaveText("docs/hello.html");
  await expect(box.frameLocator('[data-testid="thread-html-lightbox-frame"]').locator("#hello")).toHaveText("Hello");
  const lightboxFrame = await box.getByTestId("thread-html-lightbox-frame").boundingBox();
  expect(lightboxFrame?.height ?? 0).toBeGreaterThan(500);
  await shot(page, "inline-html-expanded");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId("thread-html-lightbox-frame")).toHaveCount(0);
  // The collapse action closes it too.
  await card.getByTestId("thread-html-expand").click();
  await page.getByTestId("thread-html-collapse").click();
  await expect(page.getByTestId("thread-html-lightbox")).toHaveCount(0);
});

test("a page that cannot be rendered says so, never a blank box", async ({ page }) => {
  await openHtmlThread(page);
  const card = gone(page).getByTestId("thread-html-card");
  await expect(gone(page).getByTestId("thread-html-row")).toContainText("An older page");
  await expect(card.getByTestId("thread-html-failed")).toContainText("Could not render this page.");
  await expect(card.getByTestId("thread-html-failed")).toContainText("does not exist");
  await expect(card.getByTestId("thread-html-frame")).toHaveCount(0);
  await expect(card.getByTestId("thread-html-source")).toContainText("The source cannot be read either");
});

test("open in side panel opens the file in the thread's own panel", async ({ page }) => {
  await openHtmlThread(page);
  await hello(page).getByTestId("thread-html-panel").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel-key", "thread:s-r1");
  await expect(page.getByTestId("panel-tabs").getByRole("tab", { selected: true })).toHaveText("hello.html");
});

test("the item folds with its turn: the row stays, the card and its frame go; the row opens it again", async ({ page }) => {
  await openHtmlThread(page);
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(1);
  await mockPost("thread/finish");
  await expect(page.locator('[data-testid="thread-turn-header"][data-folded]')).toHaveCount(1);
  await expect(items(page)).toHaveCount(2);
  await expect(page.getByTestId("thread-html-card")).toHaveCount(0);
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(0);
  const r = hello(page).getByTestId("thread-html-row");
  await expect(r).toHaveAttribute("aria-expanded", "false");
  await expect(r).toContainText("folded");
  await r.click();
  await expect(hello(page).getByTestId("thread-html-frame")).toBeVisible();
  // Unfolding the turn opens every card; folding it again closes them.
  await page.locator('[data-testid="thread-turn-header"]').getByRole("button", { name: "Show this turn's work" }).click();
  await expect(page.getByTestId("thread-html-card")).toHaveCount(2);
  await page.locator('[data-testid="thread-turn-header"]').getByRole("button", { name: "Hide this turn's work" }).click();
  await expect(page.getByTestId("thread-html-card")).toHaveCount(1);
});
