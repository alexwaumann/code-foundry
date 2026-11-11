import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { mockUrl, resetMock } from "./fixtures";

/**
 * The shot page (src/shot/main.tsx, docs/notes/plugin-surface-shot-page.md) in a real
 * browser against the mock: the third Vite input loads, the stage is the window's width,
 * and the ready mark appears. The controller's waits, failures and replacing are
 * unit-tested in src/shot/controller.test.ts.
 */

const shotPath = (q: string) => `/shot.html?daemon=${encodeURIComponent(mockUrl)}&token=${MOCK_TOKEN}&${q}`;

test.beforeEach(async () => {
  await resetMock();
});

async function openDemo(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.goto(shotPath("plugin=hello&surface=demo&scope=thread:s-3"));
  await expect(page.locator("html")).toHaveAttribute("data-shot-ready", /^\d+$/);
}

test("the stage is the window's width and the ready mark carries the full height", async ({ page }) => {
  await openDemo(page, 420);
  const stage = page.getByTestId("shot-stage");
  expect((await stage.boundingBox())?.width).toBe(420);
  await expect(stage.getByTestId("plugin-surface")).toHaveAttribute("data-phase", "live");
  // The demo's overview is taller than the window: the mark is its unrolled height.
  expect(Number(await page.locator("html").getAttribute("data-shot-ready"))).toBeGreaterThan(700);
});

/** Publishes the daemon's default theme for a scheme (internal/theme/frame-defaults.json), as the app would. */
async function publishDefault(scheme: "dark" | "light"): Promise<void> {
  const defaults = JSON.parse(readFileSync(new URL("../../../internal/theme/frame-defaults.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const res = await fetch(`${mockUrl}/codefoundry.v1.UiService/PublishTheme`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify(defaults[scheme]),
  });
  expect(res.ok).toBe(true);
}

/** SHOTS=<dir>: the PR's screenshots, WebKit, 420 wide, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await publishDefault(scheme);
    await openDemo(page, 420);
    const height = Number(await page.locator("html").getAttribute("data-shot-ready"));
    // A taller window for the whole surface, as a caller would ask from the report.
    await page.setViewportSize({ width: 420, height });
    await page.evaluate(() => {
      (window as unknown as { cfShot: (req: object) => void }).cfShot({ id: "tall", plugin: "hello", surface: "demo", scope: "thread:s-3" });
    });
    await expect(page.locator("html")).toHaveAttribute("data-shot-id", "tall");
    await expect(page.locator("html")).toHaveAttribute("data-shot-ready", String(height));
    await page.screenshot({ path: `${String(shots)}/shot-page-${scheme}.png` });
  });
}
