import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * The Diff tab where only a real browser can tell (docs/notes/diff-viewer-2.md): the file list
 * moving between rail and top with the panel's real width, and the list scrolling inside
 * itself. Everything else is src/components/diff/DiffView.test.tsx. Set SHOTS=<dir> to save the
 * pull request's screenshots (WebKit, dark and light, wide and narrow).
 */

const list = (page: Page) => page.getByTestId("diff-file-list");
const file = (page: Page) => page.getByTestId("diff-file");

async function panelWidth(page: Page, w: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(w)}))`);
}

async function openDiff(page: Page, width: number): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await openThreadChanges(page);
  await panelWidth(page, width);
  await expect(list(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the list follows the panel's own width, not the window's, and keeps the file on screen", async ({ page }) => {
  await openDiff(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
  await page.locator('[data-nav-key="f:README.md"]').click();
  await expect(file(page)).toHaveAttribute("data-path", "README.md");

  const rail = await list(page).boundingBox();
  const diff = await file(page).boundingBox();
  if (!rail || !diff) throw new Error("no boxes");
  expect(Math.abs(rail.x + rail.width - diff.x)).toBeLessThanOrEqual(1);
  expect(rail.height).toBeGreaterThan(400);

  // The window stays as wide as it was: only the panel narrows.
  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(file(page)).toHaveAttribute("data-path", "README.md");
  const top = await list(page).boundingBox();
  const under = await file(page).boundingBox();
  if (!top || !under) throw new Error("no boxes");
  expect(Math.abs(top.y + top.height - under.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(top.width - under.width)).toBeLessThanOrEqual(1);

  await panelWidth(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
});

test("a long list is virtualized and scrolls inside itself, in both layouts", async ({ page }) => {
  await mockPost("compare/files?count=800");
  await openDiff(page, 760);
  const rows = page.getByTestId("diff-file-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  expect(await rows.locator("[data-nav-key]").count()).toBeLessThan(120);

  const height = await rows.evaluate((e) => e.clientHeight);
  const content = await rows.evaluate((e) => e.scrollHeight);
  expect(content).toBeGreaterThan(height * 4);
  await rows.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(page.locator('[data-nav-key="f:generated/file-0799.ts"]')).toBeVisible();
  const box = await rows.boundingBox();
  const diffBox = await file(page).boundingBox();
  if (!box || !diffBox) throw new Error("no boxes");
  expect(box.y + box.height).toBeLessThanOrEqual(diffBox.y + diffBox.height + 1);

  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  expect(await rows.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(150);
  expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThan(300);
});

for (const scheme of ["dark", "light"] as const) {
  for (const [layout, width] of [["wide", 800], ["narrow", 420]] as const) {
    test(`diff viewer screenshots (${scheme}, ${layout})`, async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await page.emulateMedia({ colorScheme: scheme });
      await openDiff(page, width);
      await page.locator('[data-nav-key="f:README.md"]').click();
      await expect(file(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
      await page.mouse.move(5, 5);
      await page.screenshot({ path: `${shots ?? ""}/diff-${layout}-${scheme}.png` });
    });
  }
}
