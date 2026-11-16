import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock } from "./fixtures";

/**
 * The bell (docs/notes/notifications-3-bell.md), what only a real browser shows: the popover
 * under the bell inside the window and the keyboard's way in and out, an arrival toast over the
 * app whose button runs its action, and a card's thread link moving the window to the thread in
 * its own space. The list's order, counts, tones and which command each control runs:
 * src/components/notifications/NotificationBell.test.tsx; the toast rules:
 * src/stores/notificationToasts.test.ts. SHOTS=<dir> saves the PR's screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function notifications(): Promise<{ notifications: { id: string; title: string; status: string }[]; calls: string[] }> {
  const res = await fetch(`${mockUrl}/__mock/notifications`);
  return (await res.json()) as { notifications: { id: string; title: string; status: string }[]; calls: string[] };
}

const post = (q: string) => mockPost(`notifications/post?${q}`);
const enc = encodeURIComponent;

/** Runs a registry command from the window, as a button would. */
async function run(page: Page, name: string, args: Record<string, string>): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/commands.ts").then((m) => m.runCommand(${JSON.stringify(name)}, ${JSON.stringify(args)}))`);
}

test("the list opens under the bell inside the window, holds the keyboard, and Escape gives it back to the bell", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openApp(page);
  await mockPost("notifications/seed?quiet=1");
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toHaveAttribute("data-count", "5");
  await bell.focus();
  await page.keyboard.press("Enter");
  const pop = page.getByTestId("notification-popover");
  await expect(pop).toBeVisible();
  const [b, p] = await Promise.all([bell.boundingBox(), pop.boundingBox()]);
  if (!b || !p) throw new Error("no boxes");
  // Under the bell, its right edge at the bell's, inside the window.
  expect(p.y).toBeGreaterThanOrEqual(b.y + b.height);
  expect(Math.abs(p.x + p.width - (b.x + b.width))).toBeLessThanOrEqual(2);
  expect(p.x).toBeGreaterThanOrEqual(0);
  expect(p.y + p.height).toBeLessThanOrEqual(600);
  // The list scrolls on its own when it is taller than its room.
  const list = page.getByTestId("notification-list");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The list holds the keyboard (not a card's first button, whose tooltip would open).
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("notification-popover");
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(bell).toBeFocused();
});

test("an arrival toasts over the app; its button runs the action, and closing it leaves the notification", async ({ page }) => {
  await openApp(page);
  await post(`title=${enc("CF-213 assigned to you")}&body=${enc("Sidebar count is wrong after archive")}&source=acme-data&action=${enc("Start a thread|start|Look into CF-213")}&action=${enc("Open ticket|open|https://example.com/t")}`);
  const toast = page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-title]", { hasText: "CF-213 assigned to you" }) });
  await expect(toast).toBeVisible();
  await expect(page.getByTestId("notification-bell")).toHaveAttribute("data-count", "1");
  await toast.locator("[data-notice-buttons] button", { hasText: "Start a thread" }).click();
  await expect(toast).toBeHidden();
  await expect.poll(async () => (await notifications()).calls.at(-1)).toMatch(/^notification\.act .*"action":"1"/);
  await expect(page.getByTestId("notification-bell")).toHaveAttribute("data-count", "0");

  await post(`title=${enc("Rotate the key")}&action=${enc("Open task|open|https://example.com/k")}`);
  const second = page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-title]", { hasText: "Rotate the key" }) });
  await second.locator("[data-close-button]").click();
  await expect(second).toBeHidden();
  expect((await notifications()).notifications.find((n) => n.title === "Rotate the key")?.status).toBe("shown");
});

test("a card's thread link moves the window to the thread in its own space", async ({ page }) => {
  await openApp(page);
  await run(page, "space.new", { name: "Other", focus: "false" });
  await run(page, "thread.space.move", { id: "s-4", space: "Other" });
  await post(`title=${enc("Stage integration failed")}&level=error&thread=s-4&source=test-watcher`);
  await expect(page.getByTestId("space-tab").filter({ hasText: "Main" })).toHaveAttribute("data-current", "true");
  await page.getByTestId("notification-bell").click();
  await page.getByTestId("notification-thread").click();
  await expect(page.getByTestId("notification-popover")).toBeHidden();
  await expect(page.getByTestId("space-tab").filter({ hasText: "Other" })).toHaveAttribute("data-current", "true");
  await expect(page.getByRole("tab", { name: /Investigate flaky e2e/ }).first()).toBeVisible();
});

test("screenshots: the bell closed and open, and an arrival toast, dark and light", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await mockPost("notifications/seed?quiet=1");
  const bar = page.getByTestId("top-bar");
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await bar.screenshot({ path: `${shots}/bell-closed-${scheme}.png` });
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-popover")).toBeVisible();
    await page.mouse.move(640, 700);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/bell-open-${scheme}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notification-popover")).toBeHidden();
  }
  await post(`title=${enc("CF-213 assigned to you")}&body=${enc("Sidebar count is wrong after archive")}&source=acme-data&action=${enc("Start a thread|start|x")}&action=${enc("Open ticket|open|https://example.com/t")}`);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible();
  await toast.hover();
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/arrival-toast-${scheme}.png` });
  }
});
