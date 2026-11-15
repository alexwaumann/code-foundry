import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, openApp, resetMock } from "./fixtures";
import { openThread } from "./shell";

/**
 * Mermaid in the File tab (docs/notes/file-previews-4-mermaid.md), only what jsdom cannot
 * show: Mermaid really drawing (it measures text) a file and a markdown fence at a real
 * size, a hostile diagram drawn inert, a wide one scrolling, and nothing left in the
 * document. Kinds, meta, the error state's contents, the fence's fallback and the theme
 * mapping are vitest's (src/components/mermaid/, files/previews/MermaidBody.test.tsx).
 * SHOTS=<dir> also saves the PR's screenshots.
 */

const file = (page: Page) => page.getByTestId("file-tab");

/** Opens a File tab beside the thread the way a path chip does (stores/filePanel.ts). */
async function openFile(page: Page, path: string): Promise<void> {
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/${path}`);
}

async function size(el: Locator): Promise<{ width: number; height: number }> {
  const box = await el.boundingBox();
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

/** Nothing Mermaid made is left in the document outside our views: no temporary divs, no error graphic. */
async function strays(page: Page): Promise<number> {
  return page.evaluate(() => [...document.body.querySelectorAll('[id^="cfmmd"], [id^="dcfmmd"], [id^="icfmmd"], .error-icon')].filter((el) => !el.closest(".cf-mermaid")).length);
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await openApp(page);
  await openThread(page, "s-1");
});

test("a .mmd file and a markdown fence are drawn at a real size, in the pane's width", async ({ page }) => {
  await openFile(page, "docs/architecture.mmd");
  const svg = file(page).locator("[data-testid=file-mermaid-diagram] svg");
  await expect(svg).toBeVisible();
  await expect(svg.locator("g.node")).toHaveCount(9);
  await expect(file(page).getByTestId("file-meta")).toHaveText("Flowchart · 9 nodes · 313 B · Mermaid");
  const drawn = await size(svg);
  const pane = await size(file(page).getByTestId("file-mermaid"));
  expect(drawn.width).toBeGreaterThan(200);
  expect(drawn.height).toBeGreaterThan(100);
  expect(drawn.width).toBeLessThanOrEqual(pane.width);
  // The labels are SVG text in the app's font, not HTML.
  await expect(svg.locator("foreignObject")).toHaveCount(0);
  expect(await svg.locator("text").first().evaluate((t) => getComputedStyle(t).fontFamily)).toContain("apple-system");

  await openFile(page, "docs/diagrams.md");
  const fence = file(page).locator("[data-testid=md-mermaid-diagram] svg");
  await expect(fence).toBeVisible();
  expect((await size(fence)).height).toBeGreaterThan(100);
  await expect(file(page).getByTestId("md-mermaid-note")).toContainText("Parse error on line 3");
  expect(await strays(page)).toBe(0);
});

test("a hostile diagram is drawn inert", async ({ page }) => {
  await openFile(page, "docs/hostile.mmd");
  const view = file(page).getByTestId("file-mermaid-diagram");
  await expect(view.locator("svg g.node")).toHaveCount(4);
  const found = await view.evaluate((el) => ({
    scripts: el.querySelectorAll("script, img, image, iframe, foreignObject").length,
    handlers: [...el.querySelectorAll("*")].flatMap((n) => [...n.attributes].map((a) => a.name)).filter((n) => n.startsWith("on")),
    links: [...el.querySelectorAll("*")].flatMap((n) => [...n.attributes]).filter((a) => /href$/i.test(a.name) && !a.value.startsWith("#")).length,
    remote: el.innerHTML.includes("example.invalid"),
  }));
  expect(found).toEqual({ scripts: 0, handlers: [], links: 0, remote: false });
  await view.locator("svg g.node").last().click();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as { __cfPwned?: unknown }).__cfPwned ?? null)).toBeNull();
  expect(await strays(page)).toBe(0);
});

test("a diagram wider than the pane can shrink it to scrolls sideways", async ({ page }) => {
  await openFile(page, "docs/wide.mmd");
  const svg = file(page).locator("[data-testid=file-mermaid-diagram] svg");
  await expect(svg).toBeVisible();
  const scroller = file(page).getByTestId("file-mermaid");
  const { scrollWidth, clientWidth } = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(scrollWidth).toBeGreaterThan(clientWidth);
  const natural = await svg.evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.width);
  expect((await size(svg)).width).toBeGreaterThanOrEqual(Math.floor(natural * 0.6));
});

test("a Gantt chart is drawn at a width of its own, not as wide as the 2000px box Mermaid renders in", async ({ page }) => {
  await openFile(page, "docs/plan.mmd");
  const svg = file(page).locator("[data-testid=file-mermaid-diagram] svg");
  await expect(svg).toBeVisible();
  expect(await svg.evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.width)).toBe(800);
  expect((await size(svg)).width).toBeLessThanOrEqual(800);
});

test("a diagram that does not parse: the message, and Show source opens Source", async ({ page }) => {
  await openFile(page, "docs/broken.mmd");
  await expect(file(page).getByTestId("file-mermaid-message")).toContainText("Parse error on line 3");
  expect(await strays(page)).toBe(0);
  await file(page).getByTestId("file-mermaid-source").click();
  await expect(file(page).getByTestId("file-mode-source")).toHaveAttribute("aria-checked", "true");
  await expect(file(page).getByTestId("file-meta")).toContainText("lines");
});

const shots = process.env.SHOTS;

test("mermaid screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1400, height: 900 });
  const pane = () => page.getByTestId("shell-pane").filter({ has: file(page) });
  const shot = async (name: string, ready: () => Promise<void>) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await ready();
      await pane().screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openFile(page, "docs/architecture.mmd");
  await shot("mermaid-flowchart", () => expect(file(page).locator("[data-testid=file-mermaid-diagram] svg")).toBeVisible());
  await openFile(page, "docs/sequence.mmd");
  await shot("mermaid-sequence", () => expect(file(page).locator("[data-testid=file-mermaid-diagram] svg")).toBeVisible());
  await openFile(page, "docs/diagrams.md");
  await shot("mermaid-fence", async () => {
    await expect(file(page).locator("[data-testid=md-mermaid-diagram] svg")).toBeVisible();
    await file(page).getByTestId("md-mermaid").evaluate((el) => {
      el.scrollIntoView({ block: "center" });
    });
  });
  await shot("mermaid-fence-error", async () => {
    await file(page).getByTestId("md-mermaid-note").evaluate((el) => {
      el.scrollIntoView({ block: "center" });
    });
  });
  await openFile(page, "docs/broken.mmd");
  await shot("mermaid-error", () => expect(file(page).getByTestId("file-mermaid-message")).toBeVisible());
});
