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

test("expand shows the page over the whole window; Close has focus; Esc closes it and its frame goes", async ({ page }) => {
  await openHtmlThread(page);
  // The side panel open too: the lightbox covers it as well (inline-html-2-fixes).
  await hello(page).getByTestId("thread-html-panel").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
  const card = hello(page).getByTestId("thread-html-card");
  await card.getByTestId("thread-html-expand").click();
  const box = page.getByTestId("thread-html-lightbox");
  await expect(box).toBeVisible();
  await expect(box.getByTestId("thread-html-path")).toHaveText("docs/hello.html");
  await expect(box.frameLocator('[data-testid="thread-html-lightbox-frame"]').locator("#hello")).toHaveText("Hello");
  const lightboxFrame = await box.getByTestId("thread-html-lightbox-frame").boundingBox();
  expect(lightboxFrame?.height ?? 0).toBeGreaterThan(500);
  const inner = await box.getByTestId("thread-html-lightbox-box").boundingBox();
  const panel = await page.getByTestId("side-panel").boundingBox();
  const pane = await page.getByTestId("thread-pane").boundingBox();
  expect(inner && panel && pane).toBeTruthy();
  if (inner && panel && pane) {
    expect(inner.x).toBeLessThan(pane.x);
    expect(inner.x + inner.width).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
  }
  // Focus is on Close, not in the frame (whose keys the app never sees), so Esc works at once.
  const close = box.getByTestId("thread-html-close");
  await expect(close).toBeVisible();
  await expect(close).toBeFocused();
  await shot(page, "inline-html-expanded");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId("thread-html-lightbox-frame")).toHaveCount(0);
  // Focus goes back to Expand.
  await expect(card.getByTestId("thread-html-expand")).toBeFocused();
  // Close is reachable by keyboard from the strip's other actions, and closes it too. WebKit
  // (like Safari and the Wails window) moves between buttons with Option+Tab.
  await card.getByTestId("thread-html-expand").click();
  await box.getByTestId("thread-html-source-toggle").focus();
  await page.keyboard.press("Alt+Tab");
  await page.keyboard.press("Alt+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-html-lightbox")).toHaveCount(0);
});

/** The html-idle state: three pages shown after a finished turn, outside any (mock/thread.ts). */
async function openIdlePages(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await mockPost("thread?state=html-idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(items(page)).toHaveCount(3);
}

test("pages shown between turns arrive open, outside the turn's fold", async ({ page }) => {
  await openIdlePages(page);
  for (const name of ["hello.html", "plain.html", "scheme.html"]) {
    const r = items(page).filter({ hasText: name }).getByTestId("thread-html-row");
    await expect(r).toHaveAttribute("aria-expanded", "true");
    await expect(r).not.toContainText("folded");
  }
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(3);
  // The turn before them is folded (it ended); they are not in it, and no header follows them.
  await expect(page.locator('[data-testid="thread-turn-header"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="thread-turn-header"][data-folded]')).toHaveCount(1);
  // The chevron still closes one.
  await items(page).filter({ hasText: "plain.html" }).getByTestId("thread-html-row").click();
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(2);
});

test("a theme switch keeps a page that acks cf:theme and reloads one that only links the stylesheet", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openIdlePages(page);
  const listen = items(page).filter({ hasText: "hello.html" });
  const plain = items(page).filter({ hasText: "plain.html" });
  const listenDoc = listen.frameLocator('[data-testid="thread-html-frame"]');
  const plainDoc = plain.frameLocator('[data-testid="thread-html-frame"]');
  await listenDoc.locator("#wave").click();
  await expect(listenDoc.locator("#hello")).toHaveText("Hello x1");
  await plainDoc.locator("#tick").click();
  await expect(plainDoc.locator("#plain")).toHaveText("Ticked 1");
  const darkBg = await plainDoc.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  // The stylesheet-only page reloads (its count starts again) and repaints in the new theme.
  await expect(plain.getByTestId("thread-html-frame")).toHaveAttribute("data-load", "1");
  await expect(plainDoc.locator("#plain")).toHaveText("Stylesheet only");
  await expect.poll(() => plainDoc.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(darkBg);
  // The listening page acked: same load, state kept, repainted by the message.
  await expect(listen.getByTestId("thread-html-frame")).toHaveAttribute("data-load", "0");
  await expect(listenDoc.locator("#hello")).toHaveText("Hello x1");
  await page.emulateMedia({ colorScheme: null });
});

test("a page's prefers-color-scheme is the app's scheme, not the system's", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openIdlePages(page);
  const doc = items(page).filter({ hasText: "scheme.html" }).frameLocator('[data-testid="thread-html-frame"]');
  await expect(doc.locator("#scheme")).toHaveText("sees dark");
  // The app pinned to light while the system stays dark.
  await mockPost("settings/external?appearance.theme=light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light/);
  await expect(doc.locator("#scheme")).toHaveText("sees light");
  await expect.poll(() => doc.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  await page.emulateMedia({ colorScheme: null });
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

test("the turn's fold never touches a page: only its row closes and opens the card", async ({ page }) => {
  await openHtmlThread(page);
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(1);
  const header = page.locator('[data-testid="thread-turn-header"]');
  const r = hello(page).getByTestId("thread-html-row");
  // The turn ends while the reader watches: it folds by default, both cards stay open.
  await mockPost("thread/finish");
  await expect(page.locator('[data-testid="thread-turn-header"][data-folded]')).toHaveCount(1);
  await expect(items(page)).toHaveCount(2);
  await expect(page.getByTestId("thread-html-card")).toHaveCount(2);
  await expect(hello(page).getByTestId("thread-html-frame")).toBeVisible();
  // Unfold, then fold the turn: the cards stay open, and no row says "folded".
  await header.getByRole("button", { name: "Show this turn's work" }).click();
  await expect(page.getByTestId("thread-html-card")).toHaveCount(2);
  await header.getByRole("button", { name: "Hide this turn's work" }).click();
  await expect(page.getByTestId("thread-html-card")).toHaveCount(2);
  await expect(r).toHaveAttribute("aria-expanded", "true");
  await expect(r).not.toContainText("folded");
  // The row closes it, and the turn's fold does not open it again.
  await r.click();
  await expect(hello(page).getByTestId("thread-html-card")).toHaveCount(0);
  await header.getByRole("button", { name: "Show this turn's work" }).click();
  await expect(hello(page).getByTestId("thread-html-card")).toHaveCount(0);
  await header.getByRole("button", { name: "Hide this turn's work" }).click();
  await expect(hello(page).getByTestId("thread-html-card")).toHaveCount(0);
  await r.click();
  await expect(hello(page).getByTestId("thread-html-frame")).toBeVisible();
  await r.click();
  await expect(hello(page).getByTestId("thread-html-card")).toHaveCount(0);
  // Leaving the thread forgets the choice: on return the folded turn's cards are open.
  await page.getByTestId("thread-list").locator('[data-row-key^="s:"]:not([data-row-key="s:s-r1"])').first().click();
  await expect(items(page)).toHaveCount(0);
  await row(page, "s:s-r1").click();
  await expect(items(page)).toHaveCount(2);
  await expect(page.locator('[data-testid="thread-turn-header"][data-folded]')).toHaveCount(1);
  await expect(page.getByTestId("thread-html-card")).toHaveCount(2);
  await shot(page, "folded-open");
});
