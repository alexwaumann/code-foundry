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
