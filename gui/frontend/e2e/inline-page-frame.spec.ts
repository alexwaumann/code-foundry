import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A thread's page frame (docs/notes/inline-page-frame.md) over the mock's scripted threads:
 * no white while a page loads or reloads in a dark theme, and a wheel up over a page that
 * cannot scroll further scrolls the thread instead of bouncing back to the bottom.
 * SHOTS=<dir> saves a page mid-load and loaded, dark and light.
 */

test.beforeEach(async () => {
  await resetMock();
});

const shots = process.env.SHOTS;

/** The share of a screenshot's pixels that are near white. */
async function whiteShare(page: Page, el: Locator, path?: string): Promise<number> {
  const png = await el.screenshot(path ? { path } : {});
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    if (!g) return 1;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 0) > 245 && (d[i + 1] ?? 0) > 245 && (d[i + 2] ?? 0) > 245) white++;
    return white / (d.length / 4);
  }, png.toString("base64"));
}

async function openThread(page: Page, state: string): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

/** Holds every request for the tall page until release() (its frame stays loading). */
async function holdPage(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/preview\/.*\/docs\/tall\.html/, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

for (const scheme of ["dark", "light"] as const) {
  test(`a page shows the surface while it loads and fades in painted, never white (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const release = await holdPage(page);
    await openThread(page, "html-scroll");
    const card = page.getByTestId("thread-html-card");
    const box = card.getByTestId("thread-html-frame-box");
    const frame = card.getByTestId("thread-html-frame");
    // Loading: the frame is hidden over the surface, with the spinner.
    await expect(card.getByTestId("thread-html-frame-loading")).toBeVisible();
    await expect(frame).not.toHaveAttribute("data-shown");
    await expect(frame).toHaveCSS("opacity", "0");
    const surface = await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.backgroundColor = "var(--cf-surface)";
      document.body.append(d);
      const c = getComputedStyle(d).backgroundColor;
      d.remove();
      return c;
    });
    await expect(box).toHaveCSS("background-color", surface);
    const loading = await whiteShare(page, card, shots && `${shots}/frame-loading-${scheme}.png`);
    if (scheme === "dark") expect(loading).toBe(0);
    release();
    // Loaded: shown, painted by the daemon (no stylesheet, no background of its own).
    await expect(frame).toHaveAttribute("data-shown", "true");
    await expect(card.getByTestId("thread-html-frame-loading")).toHaveCount(0);
    await expect(frame).toHaveCSS("opacity", "1");
    const doc = card.frameLocator('[data-testid="thread-html-frame"]');
    await expect(doc.locator("#tall")).toHaveText("A tall page");
    expect(await doc.locator("meta[name=color-scheme]").getAttribute("content")).toBe(scheme);
    const loaded = await whiteShare(page, card, shots && `${shots}/frame-loaded-${scheme}.png`);
    // Only the page's own text is white (CanvasText in a dark scheme); a white page would be most of it.
    if (scheme === "dark") expect(loaded).toBeLessThan(0.1);
  });
}

test("a theme reload hides the frame over the surface again, not white", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openThread(page, "html-scroll");
  const card = page.getByTestId("thread-html-card");
  const frame = card.getByTestId("thread-html-frame");
  await expect(frame).toHaveAttribute("data-shown", "true");
  // The page does not ack cf:theme, so a new theme reloads it; the reload is held.
  const release = await holdPage(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(frame).toHaveAttribute("data-load", "1");
  await expect(frame).not.toHaveAttribute("data-shown");
  expect(await whiteShare(page, card)).toBe(0);
  release();
  await expect(frame).toHaveAttribute("data-shown", "true");
  expect(await whiteShare(page, card)).toBeLessThan(0.1);
});

test("a wheel up over a page at its top scrolls the thread, and it stays up", async ({ page }) => {
  await openThread(page, "html-scroll");
  const timeline = page.getByTestId("thread-timeline");
  const frame = page.getByTestId("thread-html-frame");
  await expect(frame).toHaveAttribute("data-shown", "true");
  await expect(page.getByTestId("thread-html-frame-box")).toBeInViewport();
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  // The page scrolls inside its card (taller than it), and it is at its own top.
  const doc = page.frameLocator('[data-testid="thread-html-frame"]');
  expect(await doc.locator("html").evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  const top = () => timeline.evaluate((el) => el.scrollTop);
  const before = await top();
  const b = await frame.boundingBox();
  if (!b) throw new Error("no frame box");
  await page.mouse.move(b.x + b.width / 2, b.y + 60);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(50);
  }
  // Up and staying up: no snap back to the bottom (after a resize hold's 400 ms too).
  await expect.poll(top).toBeLessThan(before - 200);
  await page.waitForTimeout(700);
  expect(await top()).toBeLessThan(before - 200);
  await expect(timeline).not.toHaveAttribute("data-at-bottom");
  await expect(page.getByTestId("thread-jump-bottom")).toHaveAttribute("data-shown", "true");
});
