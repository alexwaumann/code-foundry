import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock } from "./fixtures";

/**
 * Panes as the default for new homes only (docs/notes/threads-open-as-3-default.md), what only a
 * real browser shows: the notice an existing home gets, whose Open settings opens the settings
 * sheet with the Threads open as row scrolled into view and its dropdown focused, leaving the
 * notice in the bell. The step's rules are Go's (internal/store/settings defaultchange_test.go,
 * internal/daemon default_change_test.go), the mock's control mock/world.test.ts, the jump's
 * retry src/stores/views.test.ts. SHOTS=<dir> saves the PR's screenshots (WebKit, dark and light).
 */

test.beforeEach(async () => {
  await resetMock();
});

async function notices(): Promise<{ source: string; status: string }[]> {
  const res = await fetch(`${mockUrl}/__mock/notifications`);
  return ((await res.json()) as { notifications: { source: string; status: string }[] }).notifications.filter((n) => n.source === "app");
}

const card = (page: Page) => page.getByTestId("notification-card").filter({ hasText: "Threads can now open as panes" });

test("an existing home's notice: Open settings opens Settings at the Threads open as row, and the notice stays", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openApp(page);
  await mockPost("install?state=existing");
  await page.getByTestId("notification-bell").click();
  await expect(card(page)).toContainText("You are still on tabs");
  await card(page).getByTestId("notification-action").filter({ hasText: "Open settings" }).click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  const trigger = page.locator('[data-setting="layout.threads_open_as"]').getByRole("combobox");
  await expect(trigger).toBeFocused();
  await expect(trigger).toBeInViewport();
  await expect(trigger).toHaveAttribute("data-value", "tabs");
  expect(await notices()).toMatchObject([{ status: "shown" }]);
});

for (const scheme of ["dark", "light"] as const) {
  test(`the notice and the default marker screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const dir = shots ?? "";
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await mockPost("install?state=existing");
    await page.getByTestId("notification-bell").click();
    const popover = page.getByTestId("notification-popover");
    await expect(card(page)).toBeVisible();
    await page.mouse.move(640, 700);
    await page.waitForTimeout(400);
    await popover.screenshot({ path: `${dir}/notice-in-bell${suffix}.png` });
    await card(page).getByTestId("notification-action").filter({ hasText: "Open settings" }).click();
    const trigger = page.locator('[data-setting="layout.threads_open_as"]').getByRole("combobox");
    await expect(trigger).toBeFocused();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/open-settings-row${suffix}.png` });
    await trigger.click();
    await expect(page.getByRole("option", { name: /^Panes \(default\)/ })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/threads-open-as-default-marker${suffix}.png` });
  });
}
