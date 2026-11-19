import { expect, test, type Page } from "@playwright/test";
import { invocations, openApp, resetMock, row } from "./fixtures";

/**
 * Putting a thread away from the keyboard (docs/notes/put-away-chords.md): cmd+shift+a archives the
 * thread in front, cmd+shift+s snoozes it to the default snooze. Which command runs with which args,
 * the default's time and the menus' "default" mark are unit-tested (src/stores/snoozeDefault.test.ts,
 * src/components/snooze/SnoozeMenu.test.tsx); the Needs you jump on cmd+shift+n in src/keys/bindings.test.ts
 * and the specs that walk it (threads, sidebar, lineage, snooze, ember); the daemon's commands and the
 * users' own bindings of these chords in Go (internal/command, internal/daemon settings_keybindings_test.go).
 * This keeps the two chords through the window's keymap, and makes the PR's screenshots (SHOTS=<dir>).
 */

const shots = process.env.SHOTS;

// s-3 "Fix resize race" and s-4: idle, nothing running, so neither asks first.
test.beforeEach(async () => {
  await resetMock();
});

async function front(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
}

test("cmd+shift+a archives the thread in front; cmd+shift+s snoozes the next to the default, tomorrow", async ({ page }) => {
  await openApp(page);
  await front(page, "s-3");
  await page.keyboard.press("Meta+Shift+A");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.context?.activeThreadId)).toEqual(["s-3"]);
  await expect(page.getByTestId("archived-header")).toBeVisible();

  await front(page, "s-4");
  await page.keyboard.press("Meta+Shift+S");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.snooze").map((i) => [i.context?.activeThreadId, i.args.until !== undefined])).toEqual([["s-4", true]]);
  const until = new Date((await invocations()).find((i) => i.name === "thread.snooze")?.args.until ?? "");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  expect(until.getTime()).toBe(tomorrow.getTime());
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
  await page.screenshot({ path: `${shots ?? ""}/${name}.png` });
}

for (const scheme of ["dark", "light"] as const) {
  test(`the snooze menu's default and the settings row, ${scheme} (screenshots)`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1100, height: 700 });
    await openApp(page);
    const r = row(page, "s:s-3");
    await r.hover();
    await r.getByTestId("row-snooze").click();
    const menu = page.getByTestId("row-snooze-menu");
    await expect(menu).toBeVisible();
    await shot(page, `snooze-menu-${scheme}`);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Meta+Comma");
    const settings = page.getByTestId("settings-page");
    await expect(settings.locator('[data-setting="threads.default_model"]')).toBeVisible();
    await shot(page, `settings-threads-${scheme}`);
  });
}
