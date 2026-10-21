import { expect, test } from "@playwright/test";
import { invocations, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

// The palette ranks matches across categories (title > name > category); it used to list
// them in category order, so "help" + Enter relaunched the app.
test("a query puts the obvious command first", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const palette = page.getByTestId("palette");
  const first = palette.locator("[cmdk-item]").first();
  const highlighted = palette.locator('[cmdk-item][data-selected="true"]');

  for (const [query, want] of [
    ["help", "view.help"],
    ["split", "view.panel.split"],
    ["settings", "view.settings"],
  ] as const) {
    await page.keyboard.press("Meta+k");
    await page.keyboard.type(query);
    await expect(first).toHaveAttribute("data-command", want);
    await expect(highlighted).toHaveAttribute("data-command", want);
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  }

  // "panel": a panel command, not whatever early category matched loosely.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("panel");
  await expect(first).toContainText("Panel");
  await expect(palette.locator("[cmdk-group-heading]")).toHaveText(["Results"]);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // Enter on "help" opens help, it does not relaunch the app.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("help");
  await expect(highlighted).toHaveAttribute("data-command", "view.help");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  expect((await invocations()).map((i) => i.name)).not.toContain("app.relaunch");

  // The empty query keeps the category groups.
  await page.keyboard.press("Meta+k");
  await expect(palette.locator("[cmdk-group-heading]").first()).not.toHaveText("Results");
});
