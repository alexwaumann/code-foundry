import { expect, test, type Page } from "@playwright/test";
import { invocations, openApp, resetMock, row } from "./fixtures";

/**
 * Mark as unread (docs/notes/thread-mark-unread.md). The menu items, which command runs and
 * when it is offered are unit-tested (src/components/thread/ThreadMenuItems.test.tsx,
 * src/lib/markUnread.test.ts, src/keys/bindings.test.ts); the daemon's rule and its hold
 * while the thread is showing are tested in Go (internal/store/thread/unread_test.go). This
 * keeps the chord through the window's keymap, and makes the PR's screenshots (SHOTS=<dir>).
 */

const shots = process.env.SHOTS;

// s-3 "Fix resize race": stopped, idle at its prompt.
const IDLE = "s-3";

test.beforeEach(async () => {
  await resetMock();
});

test("cmd+shift+u marks the thread in front unread: its row shows Done", async ({ page }) => {
  await openApp(page);
  await row(page, `s:${IDLE}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", IDLE);
  const status = row(page, `s:${IDLE}`).getByTestId("thread-body");
  await expect(status).not.toHaveAttribute("data-status-line", "finished");
  await page.keyboard.press("Meta+Shift+U");
  await expect(status).toHaveAttribute("data-status-line", "finished");
  expect((await invocations()).filter((i) => i.name === "thread.unread")).toHaveLength(1);
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
  await page.screenshot({ path: `${shots ?? ""}/${name}.png` });
}

for (const scheme of ["dark", "light"] as const) {
  test(`the row's menu and the row marked, ${scheme} (screenshots)`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1100, height: 700 });
    await openApp(page);
    const r = row(page, `s:${IDLE}`);
    await r.click({ button: "right" });
    const menu = page.getByTestId("row-menu");
    await expect(menu).toBeVisible();
    await shot(page, `mark-unread-menu-${scheme}`);
    const item = menu.getByTestId("menu-mark-unread");
    if ((await item.count()) > 0) await item.click();
    else await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.mouse.move(700, 600);
    await shot(page, `mark-unread-row-${scheme}`);
  });
}
