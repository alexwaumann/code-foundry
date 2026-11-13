import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The Compact chip and row (docs/notes/compact-button.md) over the mock's "Fix stale PR badge"
 * with a 412K context. The rule is unit-tested in src/lib/compact.test.ts, the chip and the row
 * in ThreadComposer.test.tsx and ThreadInfoCard.test.tsx. Left here: a real double click through
 * the daemon's streams, and the chip's place among its siblings. Set SHOTS=<dir> to save
 * screenshots (the light pass runs only then).
 */

test.beforeEach(async () => {
  await resetMock();
  // The card off for threads never toggled (on by default), so its toggle shows it.
  await infoCardOff();
});

const schemes = process.env.SHOTS ? (["dark", "light"] as const) : (["dark"] as const);

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

for (const scheme of schemes) {
  test(`${scheme}: a double click on the chip compacts once and the row and chip go`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockPost("thread?state=idle");
    await mockPost("thread/cache?id=s-r1&tokens=412000");
    await openApp(page);
    await row(page, "s:s-r1").click();
    await page.getByTestId("thread-info-toggle").click();
    const chip = page.getByTestId("thread-compact");
    const cardRow = page.getByTestId("ti-compact");
    await expect(chip).toHaveText("Compact · 412K");
    await expect(cardRow).toBeVisible();
    const permission = await page.getByTestId("thread-permission-mode").boundingBox();
    const box = await chip.boundingBox();
    expect(box && permission && box.x >= permission.x + permission.width && box.y === permission.y && box.height === permission.height).toBe(true);
    await shot(page, `thread-compact-chip-${scheme}`);

    await chip.dblclick();
    await expect(page.getByTestId("thread-compaction")).toHaveCount(1);
    await expect(chip).toHaveCount(0);
    await expect(cardRow).toHaveCount(0);
    await expect(page.getByTestId("thread-timeline").getByText("/compact", { exact: true })).toHaveCount(1);
    await shot(page, `thread-compact-done-${scheme}`);
  });
}
