import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock } from "./fixtures";

/**
 * Settings › Memory (docs/notes/memory-page.md) against the mock's app memory
 * (mock/memory.ts): four entries, by s-1 "Refactor sidebar tree", by s-3 "Fix resize race",
 * from the user's terminal, and by s-gone "Usage page polish", which the mock no longer has.
 */

async function openMemory(page: Page): Promise<void> {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-memory").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
}

const rows = (page: Page) => page.getByTestId("memory-row");

test.beforeEach(async () => {
  await resetMock();
});

// The list, an entry too long for threads, live updates, Forget, a stale list, Forget all, the empty state and the
// Remembered toast's link: unit-tested in src/components/memory/settings/RememberedSection.test.tsx,
// src/components/confirm/ConfirmDialog.test.tsx and src/stores/intents.test.ts.

test("the settings search finds Remembered and opens the page there", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("remembered");
  await expect(page.getByTestId("settings-section-hit")).toHaveText(["Memory › RememberedEvery thread in every project reads these before its first action."]);
  await page.getByTestId("settings-section-hit").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
  await expect(page.locator('[data-section="remembered"]')).toBeInViewport();
  for (const word of ["forget", "preferences", "standing"]) {
    await page.getByRole("searchbox", { name: "Search settings" }).fill(word);
    await expect(page.getByTestId("settings-section-hit").filter({ hasText: "Memory › Remembered" })).toHaveCount(1);
  }
});

/** SHOTS=<dir>: the page with entries and empty, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMemory(page);
    await expect(rows(page)).toHaveCount(4);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/memory-${scheme}.png` });
    await mockPost("memory?set=long");
    await expect(page.getByTestId("memory-left-out")).toBeVisible();
    await page.getByTestId("memory-left-out").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${String(shots)}/memory-long-${scheme}.png` });
    await mockPost("memory?set=empty");
    await expect(page.getByTestId("memory-empty")).toBeVisible();
    await page.screenshot({ path: `${String(shots)}/memory-empty-${scheme}.png` });
  });
}
