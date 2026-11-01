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
  await expect(frame).toHaveAttribute("sandbox", /allow-same-origin/);
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

// Source swapping the frame for the file's code and back: unit-tested in
// src/components/thread/InlineHtml.test.tsx (the code view's lines: e2e/file-tabs.spec.ts).

test("expand shows the page over the thread pane's body only; the sidebar and side panel stay usable; Close has focus; Esc closes it", async ({ page }) => {
  await openHtmlThread(page);
  // The side panel open too: the modal stays clear of it (inline-page-shows).
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
  // The box sits 12px inside the pane's body: under the header, left of the side panel.
  const inner = await box.getByTestId("thread-html-lightbox-box").boundingBox();
  const scrim = await box.boundingBox();
  const panel = await page.getByTestId("side-panel").boundingBox();
  const pane = await page.getByTestId("thread-pane").boundingBox();
  const header = await page.getByTestId("thread-header").boundingBox();
  expect(inner && scrim && panel && pane && header).toBeTruthy();
  if (inner && scrim && panel && pane && header) {
    expect(scrim.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(scrim.x).toBeGreaterThanOrEqual(pane.x - 1);
    expect(scrim.x + scrim.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
    expect(inner.x - scrim.x).toBeCloseTo(12, 0);
    expect(inner.y - scrim.y).toBeCloseTo(12, 0);
    expect(scrim.x + scrim.width - (inner.x + inner.width)).toBeCloseTo(12, 0);
    expect(scrim.y + scrim.height - (inner.y + inner.height)).toBeCloseTo(12, 0);
    expect(inner.x + inner.width).toBeLessThan(panel.x);
  }
  // One frame per file: the card keeps its row and strip, its frame gives way to the surface.
  await expect(card.getByTestId("thread-html-strip")).toBeVisible();
  await expect(card.getByTestId("thread-html-frame")).toHaveCount(0);
  await expect(card.getByTestId("thread-html-covered")).toBeVisible();
  // Focus is on Close, not in the frame (whose keys the app never sees), so Esc works at once.
  const close = box.getByTestId("thread-html-close");
  await expect(close).toBeVisible();
  await expect(close).toBeFocused();
  await shot(page, "inline-html-expanded");
  // The side panel takes clicks while the modal is up.
  await page.getByTestId("side-panel").getByRole("tab").first().click();
  await expect(box).toBeVisible();
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId("thread-html-lightbox-frame")).toHaveCount(0);
  await expect(card.getByTestId("thread-html-frame")).toBeVisible();
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
  // A click on the dimmed edge closes it too.
  await card.getByTestId("thread-html-expand").click();
  const edge = await box.boundingBox();
  if (edge) await page.mouse.click(edge.x + 4, edge.y + edge.height / 2);
  await expect(page.getByTestId("thread-html-lightbox")).toHaveCount(0);
});

// The open page kept per pane (its source mode, Close focused, the card left without a frame) and
// forgotten once closed: unit-tested in src/components/thread/InlineHtml.test.tsx. Left here: the
// sidebar working while the modal is up, and the modal's frame loading the page again on return.
test("the open page is kept per thread: the sidebar works while it is up, and its page loads again on return", async ({ page }) => {
  await openHtmlThread(page);
  await hello(page).getByTestId("thread-html-card").getByTestId("thread-html-expand").click();
  const box = page.getByTestId("thread-html-lightbox");
  await expect(box).toBeVisible();
  // The sidebar is outside the modal: another thread opens, with no modal of its own.
  await page.getByTestId("thread-list").locator('[data-row-key^="s:"]:not([data-row-key="s:s-r1"])').first().click();
  await expect(items(page)).toHaveCount(0);
  await expect(box).toHaveCount(0);
  await shot(page, "inline-html-away");
  await row(page, "s:s-r1").click();
  await expect(box).toBeVisible();
  await expect(box.frameLocator('[data-testid="thread-html-lightbox-frame"]').locator("#hello")).toHaveText("Hello");
  await shot(page, "inline-html-back");
});

/** The html-idle state: three pages shown after a finished turn, outside any (mock/thread.ts). */
async function openIdlePages(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await mockPost("thread?state=html-idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(items(page)).toHaveCount(3);
}

// Pages shown between turns arriving open, outside the turn's fold, the row still closing one: src/lib/threadTimeline.test.ts ("shown between turns: no turn, no header, never folded") and src/components/thread/rows.test.tsx ("a finished turn …: the row is there and the card open…", "only its row closes the card…").

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

// A page that cannot be rendered saying so, open in side panel (the thread's own panel; the tab's
// title: src/stores/filePanel.test.ts), and the turn's fold never touching a page (only its row
// closes and opens the card; leaving the thread forgets that): unit-tested in
// src/components/thread/InlineHtml.test.tsx and rows.test.tsx.

/** SHOTS=<dir>: a finished turn's cards, open under its fold. */
test("the folded turn's open cards (screenshot)", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  await openHtmlThread(page);
  await mockPost("thread/finish");
  await expect(page.locator('[data-testid="thread-turn-header"][data-folded]')).toHaveCount(1);
  await expect(page.getByTestId("thread-html-card")).toHaveCount(2);
  await shot(page, "folded-open");
});
