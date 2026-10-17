import { expect, test, type Page } from "@playwright/test";
import { emit, mockPost, openApp, openProjects, resetMock, row } from "./fixtures";

/**
 * The Usage side panel surface (docs/notes/session-usage.md, "Panel surface"): a thread's
 * cost, tokens and requests, per model and per token kind. s-1 is seeded with Opus 5.5
 * and Fable 5.1 buckets (mock/usage.ts); POST /__mock/usage adds more. Set SHOTS=<dir> to
 * save the notes' screenshots (WebKit, 1400x900, dark and light).
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const empty = (page: Page) => page.getByTestId("panel-empty");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const surface = (page: Page) => page.getByTestId("usage-surface");

async function expectUsageTab(page: Page, thread = "s-1"): Promise<void> {
  await expect(panel(page)).toHaveAttribute("data-panel-key", `thread:${thread}`);
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveText("Usage");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "usage");
}

async function addUsage(thread: string, model: string, counters: Record<string, number>): Promise<void> {
  const q = Object.entries(counters)
    .map(([k, v]) => `&${k}=${String(v)}`)
    .join("");
  expect(await mockPost(`usage?thread=${thread}&model=${encodeURIComponent(model)}${q}`)).toEqual({ ok: true });
}

test.beforeEach(async () => {
  await resetMock();
});

test("U opens the thread's usage: cost, tokens and requests, per model and per token kind", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+Shift+e");
  await expect(empty(page).locator('[data-surface="usage"]')).toBeVisible();
  await page.keyboard.press("u");
  await expectUsageTab(page);

  await expect(surface(page).getByTestId("usage-cost")).toHaveText("$237.82");
  await expect(surface(page).getByTestId("usage-summary")).toHaveText("362M tokens · 412 requests");
  await expect(surface(page).getByTestId("usage-model-name")).toHaveText(["claude-opus-5-5", "claude-fable-5-1"]);
  await expect(surface(page).getByTestId("usage-model-meta")).toHaveText(["261M tokens · 290 requests", "101M tokens · 122 requests"]);
  await expect(surface(page).getByTestId("usage-model-cost")).toHaveText(["$129.54", "$108.28"]);
  await expect(surface(page).getByTestId("usage-model-share")).toHaveText(["54.5%", "45.5%"]);
  await expect(surface(page).getByTestId("usage-unpriced")).toHaveCount(0);
  await expect(surface(page).getByTestId("usage-kind-tokens")).toHaveText(["12.9K", "980K", "349M", "1.5M", "10.7M"]);
  await expect(surface(page).getByTestId("usage-kind-cost")).toHaveText(["$0.07", "$27.40", "$74.65", "$10.50", "$125.20"]);

  // The swatch is the model's slot colour (opus: blue).
  const bg = await surface(page).getByTestId("usage-swatch").first().evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).toMatch(/rgb\((42, 120, 214|57, 135, 229)\)|#(2a78d6|3987e5)|color\(srgb/);
});

test("a thread without usage says so, then fills in live; an unknown model is unpriced", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await page.keyboard.press("Meta+Shift+e");
  await page.keyboard.press("u");
  await expectUsageTab(page, "s-2");
  await expect(page.getByTestId("usage-empty")).toContainText("No usage yet");

  await addUsage("s-2", "claude-opus-5", { requests: 14, cacheRead: 28_400_000 });
  await expect(surface(page).getByTestId("usage-model-name")).toHaveText(["claude-opus-5"]);
  await expect(surface(page).getByTestId("usage-unpriced")).toHaveText("unpriced");
  await expect(surface(page).getByTestId("usage-model-cost")).toHaveText("—");
  await expect(surface(page).getByTestId("usage-cost")).toHaveText("—");
  await expect(surface(page).getByTestId("usage-summary")).toHaveText("28.4M tokens · 14 requests");

  // A priced model arrives: it leads, and the unpriced one keeps its dash.
  await addUsage("s-2", "claude-sonnet-5-5", { requests: 1, input: 1_000_000, output: 100_000 });
  await expect(surface(page).getByTestId("usage-model-name")).toHaveText(["claude-sonnet-5-5", "claude-opus-5"]);
  await expect(surface(page).getByTestId("usage-model-cost")).toHaveText(["$3.00", "—"]);
  await expect(surface(page).getByTestId("usage-model-share")).toHaveText(["100.0%", "—"]);
  await expect(surface(page).getByTestId("usage-cost")).toHaveText("$3.00");
  await expect(surface(page).getByTestId("usage-summary")).toHaveText("29.5M tokens · 15 requests");
});

test("the palette and the CLI's ShowView open it for a thread; a plain terminal does not list it", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Usage in Side Panel");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.usage"]').click();
  await expect(palette).toHaveCount(0);
  await expectUsageTab(page, "s-2");
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  await row(page, "s:s-1").click();
  expect(await emit({ showView: { name: "panel.usage" } })).toBeGreaterThan(0);
  await expectUsageTab(page);
  await expect(surface(page).getByTestId("usage-cost")).toHaveText("$237.82");

  // A page is no thread: not in the palette, not in the empty panel.
  await openProjects(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Usage in Side Panel");
  await expect(palette.locator('[data-command="view.panel.usage"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+e");
  await expect(empty(page)).toBeVisible();
  await expect(empty(page).locator('[data-surface="usage"]')).toHaveCount(0);
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1400x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    const shot = (name: string) => page.screenshot({ path: `${String(shots)}/${name}${suffix}.png` });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await addUsage("s-1", "claude-opus-5", { requests: 14, cacheRead: 28_400_000 });
    await openApp(page);
    await row(page, "s:s-1").click();
    await page.keyboard.press("Meta+Shift+e");
    await page.keyboard.press("u");
    await expect(surface(page).getByTestId("usage-unpriced")).toBeVisible();
    await page.mouse.move(0, 0);
    await shot("usage-panel");

    await row(page, "s:s-2").click();
    await page.keyboard.press("Meta+Shift+e");
    await page.keyboard.press("u");
    await expect(page.getByTestId("usage-empty")).toBeVisible();
    await page.mouse.move(0, 0);
    await shot("usage-empty");
  });
}
