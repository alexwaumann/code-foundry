import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The page library (docs/notes/page-library.md): pages the model shows inline, built on the
 * daemon's /cf/react.js, /cf/ui.js, /cf/ui.css, /cf/icons.js, /cf/jsx.js and /cf/tailwind.js
 * (served by the mock from internal/pagelib/dist). The scripted thread's "pagelib" state
 * (mock/thread.ts) shows mock/pagelib/*.html. SHOTS=<dir> saves each card in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

const shots = process.env.SHOTS;

const card = (page: Page, file: string) => page.getByTestId("thread-html").filter({ hasText: `${file}.html` }).getByTestId("thread-html-card");
const doc = (page: Page, file: string) => card(page, file).frameLocator('[data-testid="thread-html-frame"]');

async function openPages(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await mockPost("thread?state=pagelib");
  await openApp(page);
  await row(page, "s:s-r1").click();
}

async function snap(page: Page, file: string): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    await card(page, file).scrollIntoViewIfNeeded();
    await card(page, file).screenshot({ path: `${shots}/pagelib-${file}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

/** The computed style property of the first element matching selector in a card's page. */
const style = (page: Page, file: string, selector: string, prop: string) =>
  doc(page, file).locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test("a React page with @cf/ui renders its Tabs, Table, Dialog and icons from the bridge's data, and repaints on a theme switch", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openPages(page);
  const board = doc(page, "board");
  await card(page, "board").scrollIntoViewIfNeeded();
  await expect(board.locator("html")).toHaveAttribute("data-cf-jsx", "ready");
  if (shots) await page.screenshot({ path: `${shots}/pagelib-thread.png` });
  // The Table, filled by cf.on("thread-list") inside a React effect.
  await expect(board.getByTestId("count")).toHaveText(/^\d+ open$/);
  await expect(board.locator('[data-slot="table-row"]').nth(1)).toBeVisible();
  // A lucide icon from @cf/icons.
  await expect(board.getByTestId("icon")).toHaveAttribute("class", /lucide/);
  expect(await board.getByTestId("icon").evaluate((el) => el.getBoundingClientRect().width)).toBe(16);
  // The components carry the app's classes: the Card is the raised surface with its border.
  const dark = await style(page, "board", '[data-slot="card"]', "background-color");
  expect(dark).not.toBe("rgba(0, 0, 0, 0)");
  expect(await style(page, "board", '[data-slot="card"]', "border-top-style")).toBe("solid");
  expect(await style(page, "board", '[data-slot="card-title"]', "font-weight")).toBe("600");
  // Tabs switch.
  await board.getByRole("tab", { name: "About" }).click();
  await expect(board.getByTestId("about")).toBeVisible();
  await board.getByRole("tab", { name: "Table" }).click();
  // A Dialog opens inside the page's frame, with its title from the row.
  await board.getByRole("button", { name: "Details" }).first().click();
  const dialog = board.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).not.toHaveText("");
  if (shots) {
    await card(page, "board").screenshot({ path: `${shots}/pagelib-board-dialog-dark.png` });
  }
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  // A theme switch repaints it (the bridge applies the new slots; the variables move).
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => style(page, "board", '[data-slot="card"]', "background-color")).not.toBe(dark);
  await expect(board.locator("html")).toHaveAttribute("data-cf-jsx", "ready");
  await page.emulateMedia({ colorScheme: null });
  await snap(page, "board");
});

test("a Tailwind-runtime page styles itself with the app's tokens, arbitrary values and its own @theme", async ({ page }) => {
  await openPages(page);
  const tw = doc(page, "tailwind");
  const box = tw.locator("#box");
  await expect.poll(() => box.evaluate((el) => getComputedStyle(el).width)).toBe("217px");
  expect(await box.evaluate((el) => getComputedStyle(el).padding)).toBe("13px");
  expect(await box.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("12px");
  // bg-cf-accent is the theme's accent slot.
  const accent = await box.evaluate((el) => getComputedStyle(document.documentElement).getPropertyValue("--cf-accent").trim() && getComputedStyle(el).backgroundColor);
  expect(accent).not.toBe("rgba(0, 0, 0, 0)");
  // The type role from index.css, through the runtime.
  expect(await box.evaluate((el) => getComputedStyle(el).fontSize)).toBe("15px");
  await expect.poll(() => tw.locator("#brand").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 107, 53)");
  await snap(page, "tailwind");
});

test("a TSX syntax error shows in a box in the page, with the line", async ({ page }) => {
  await openPages(page);
  const broken = doc(page, "broken");
  await expect(broken.locator("html")).toHaveAttribute("data-cf-jsx", "error");
  const box = broken.locator("[data-cf-jsx-error]");
  await expect(box).toBeVisible();
  await expect(box).toContainText("Syntax error in");
  await expect(box).toContainText("const App = () => <div>unclosed;");
  await snap(page, "broken");
});

test("a mockup with its own CSS and no theme.css renders its own look, React and icons", async ({ page }) => {
  await openPages(page);
  const mockup = doc(page, "mockup");
  await expect(mockup.locator("html")).toHaveAttribute("data-cf-jsx", "ready");
  await expect(mockup.getByText("Meditate")).toBeVisible();
  await expect(mockup.getByTestId("flame")).toHaveAttribute("class", /lucide/);
  expect(await mockup.locator("html").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(251, 247, 240)");
  // No theme: the slots are not there, only the bridge's (which sizes the card).
  expect(await mockup.locator("link[href*='/cf/theme.css']").count()).toBe(0);
  await snap(page, "mockup");
});
