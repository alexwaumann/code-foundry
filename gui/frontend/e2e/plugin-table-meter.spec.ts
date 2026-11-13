import { expect, test, type Page } from "@playwright/test";
import { openHelloDemo, resetMock } from "./fixtures";
import { setSurfaceWidth } from "./shell-surfaces";

/**
 * A table's meter cells in a real browser (docs/notes/plugin-table-meter.md) against the
 * mock's hello demo (the Runs tab's "Suites in #1285"): in a pane as wide as the side panel was, each
 * track takes what its cell leaves beside the 40 px label slot, the tracks line up, and the
 * labels fit their slot uncut in WebKit's caption font; at the narrowest panel the labels
 * go and the tracks take the whole cell (the panel's widths, 420 and its narrowest 280 px, are now
 * its pane's: 420, and a plugin pane's narrowest, 300). The fill's width per value, the tone colours, the
 * meter role and the tooltip: src/components/plugin/meter.test.ts and metercell.test.tsx.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const suites = (page: Page) => surface(page).locator('[data-testid="plugin-table"][data-key="suites"]');

/** The demo's pane `px` wide, as the side panel was. */
const setPanelWidth = (page: Page, px: number) => setSurfaceWidth(page, "plugin-surface", px);

/** Thread s-3 open, the hello demo's Runs tab beside it in a pane the side panel's default width, the suites table in view. */
async function openSuites(page: Page): Promise<void> {
  await openHelloDemo(page);
  await setPanelWidth(page, 420);
  await surface(page).getByRole("tab", { name: "Runs" }).click();
  await suites(page).scrollIntoViewIfNeeded();
}

/** Each meter's cell, track and label box, and whether its label is cut. */
async function meters(page: Page) {
  return suites(page).evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('[data-testid="plugin-meter"]')].map((m) => {
      const cell = m.parentElement?.getBoundingClientRect();
      const track = m.querySelector('[data-testid="plugin-meter-track"]')?.getBoundingClientRect();
      const fill = m.querySelector('[data-testid="plugin-meter-fill"]')?.getBoundingClientRect();
      const label = m.querySelector<HTMLElement>('[data-testid="plugin-meter-label"]');
      return {
        cell: { x: cell?.x ?? 0, width: cell?.width ?? 0 },
        track: { x: track?.x ?? 0, width: track?.width ?? 0, height: track?.height ?? 0 },
        fill: fill?.width ?? 0,
        label: label ? { text: label.textContent, width: label.getBoundingClientRect().width, right: label.getBoundingClientRect().right, cut: label.scrollWidth > label.clientWidth } : null,
        right: cell ? cell.x + cell.width : 0,
      };
    }),
  );
}

test.beforeEach(async () => {
  await resetMock();
});

test("in a pane the side panel's width the tracks share the cell with the label slot and line up, and every label fits uncut", async ({ page }) => {
  await openSuites(page);
  const ms = await meters(page);
  expect(ms).toHaveLength(6);
  const first = ms[0];
  if (!first) throw new Error("no meter");
  // A 386 px box: Pass rate is a third of 352 px, over the 96 px the label needs.
  expect(first.cell.width).toBeCloseTo(352 / 3, 0);
  for (const m of ms) {
    expect(m.track.height).toBe(6);
    expect(m.track.width).toBeCloseTo(m.cell.width - 8 - 40, 0);
    expect(m.track.x).toBeCloseTo(first.track.x, 0);
    expect(m.label?.width).toBe(40);
    expect(m.label?.right).toBeCloseTo(m.right, 0);
    expect(m.label?.cut).toBe(false);
  }
  // 41 % of the track; lint's 0 draws none.
  expect(ms[2]?.fill).toBeCloseTo(0.41 * first.track.width, 0);
  expect(ms[5]?.fill).toBe(0);
});

test("at the narrowest pane the labels go and each track takes its whole cell", async ({ page }) => {
  await openSuites(page);
  await setPanelWidth(page, 300);
  await expect(suites(page).getByTestId("plugin-meter-label")).toHaveCount(0);
  const ms = await meters(page);
  expect(ms).toHaveLength(6);
  for (const m of ms) {
    expect(m.cell.width).toBeLessThan(96);
    expect(m.track.width).toBeCloseTo(m.cell.width, 0);
    expect(m.label).toBeNull();
  }
  // A sliver of 1 of 5 still shows beside nothing in lint.
  expect(ms[4]?.fill).toBeGreaterThanOrEqual(2);
});

/** SHOTS=<dir>: the PR's screenshots, WebKit at 2x, dark and light: the suites table at the side panel's width and at the narrowest, as a pane's. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("meters", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const dir = String(shots);
      await openSuites(page);
      await page.mouse.move(0, 0);
      await suites(page).screenshot({ path: `${dir}/meter-panel-${scheme}.png` });
      await setPanelWidth(page, 300);
      await expect(suites(page).getByTestId("plugin-meter-label")).toHaveCount(0);
      const fuzz = suites(page).locator('[data-testid="plugin-table-row"][data-key="su-fuzz"]').getByTestId("plugin-meter-track");
      await fuzz.hover();
      await expect(page.getByRole("tooltip")).toHaveText("3 of 8");
      await page.waitForTimeout(300);
      const box = await suites(page).boundingBox();
      if (!box) throw new Error("no table");
      await page.screenshot({ path: `${dir}/meter-narrow-${scheme}.png`, clip: { x: box.x - 8, y: box.y - 40, width: box.width + 16, height: box.height + 48 } });
    });
  });
}
