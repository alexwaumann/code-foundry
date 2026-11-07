import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A page's question (docs/notes/settings-user-only.md), where only a real frame shows it:
 * where the focus lands, when Change comes on, and whether the app sees the user in the
 * frame. The rules behind them are in src/stores/bridgeHost.test.ts,
 * src/stores/confirm.test.ts and src/components/confirm/ConfirmDialog.test.tsx.
 */

test.beforeEach(async () => {
  await resetMock();
});

const card = (page: Page) => page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-card");
const doc = (page: Page) => card(page).frameLocator('[data-testid="thread-html-frame"]');
const dialog = (page: Page) => page.getByTestId("confirm-dialog");

async function openBridgeThread(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=bridge");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(card(page)).toBeVisible();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
}

const ranConfirmed = async (): Promise<boolean> => (await invocations()).some((i) => i.name === "thread.archive" && i.confirmed);

/** WCAG relative luminance of a computed `rgb(…)` colour. */
const luminance = (colour: string): number => {
  const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

/** A call made by the page's script with no press behind it. */
const callFromPage = (page: Page) =>
  doc(page)
    .locator("body")
    .evaluate(() => {
      void (window as unknown as { cf: { run: (verb: string) => Promise<unknown> } }).cf.run("thread.archive").catch(() => undefined);
    });

test("the question opens on Cancel with Change off, so a key meant for the page says no", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  await expect(dialog(page).getByTestId("confirm-cancel")).toBeFocused();
  await expect(dialog(page).getByTestId("confirm-ok")).toBeDisabled();
  await page.keyboard.press("Space");
  await expect(dialog(page)).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await ranConfirmed()).toBe(false);
});

test("Change comes on after the wait and only then answers", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  const ok = dialog(page).getByTestId("confirm-ok");
  await expect(ok).toBeDisabled();
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(ranConfirmed).toBe(true);
});

test("presses in a row keep Change off", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  const ok = dialog(page).getByTestId("confirm-ok");
  await expect(ok).toBeDisabled();
  const box = await ok.boundingBox();
  if (!box) throw new Error("no Change button");
  // In the page, so a busy machine cannot stretch the gaps past the wait. Each press goes to
  // what is really at that point: the dialog while Change is off, Change once it is on.
  await page.evaluate(
    ({ x, y }) =>
      new Promise<void>((done) => {
        let presses = 0;
        const stream = setInterval(() => {
          const at = document.elementFromPoint(x, y);
          at?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          at?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          (at as HTMLElement | null)?.click();
          if (++presses === 12) {
            clearInterval(stream);
            done();
          }
        }, 150);
      }),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  await expect(ok).toBeDisabled();
  expect(await ranConfirmed()).toBe(false);
  await expect(ok).toBeEnabled();
});

test("the question stays readable under any theme", async ({ page }) => {
  await openBridgeThread(page);
  // What a theme's pins do (lib/theme.ts): every slot the same colour, text on background.
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const name of [...root.style]) if (name.startsWith("--cf-")) root.style.setProperty(name, "#14181e");
  });
  await doc(page).locator("#archive").click();
  const ok = dialog(page).getByTestId("confirm-ok");
  await expect(ok).toBeEnabled();
  const colours = await dialog(page).evaluate((d) => {
    const style = (slot: string) => getComputedStyle(d.querySelector(slot) ?? d);
    const background = getComputedStyle(d).backgroundColor;
    return [
      [style("[data-slot=dialog-title]").color, background],
      [style("[data-slot=dialog-description]").color, background],
      [style("[data-testid=confirm-cancel]").color, background],
      [style("[data-testid=confirm-ok]").color, style("[data-testid=confirm-ok]").backgroundColor],
    ] as [string, string][];
  });
  for (const [text, under] of colours) expect(contrast(text, under)).toBeGreaterThan(4.5);
});

test("a call while the user is in the composer opens nothing, even if the page takes the focus", async ({ page }) => {
  await openBridgeThread(page);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("hello");
  await callFromPage(page);
  await page.waitForTimeout(400);
  await expect(dialog(page)).toHaveCount(0);
  await doc(page)
    .locator("body")
    .evaluate(() => {
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
    });
  await callFromPage(page);
  await page.waitForTimeout(400);
  await expect(dialog(page)).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name === "thread.archive")).toEqual([]);
});
