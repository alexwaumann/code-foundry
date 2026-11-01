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
  // Rows near the viewport's edge remount while the timeline measures and pins to the bottom,
  // and a remounted card's frame loads again: in view, and a poll that rides a detach.
  await card(page, "tailwind").scrollIntoViewIfNeeded();
  await expect.poll(() => box.evaluate((el) => getComputedStyle(el).width).catch(() => "detached")).toBe("217px");
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

/** A card's page, scrolled into view and run (its frame loads only on screen). */
async function shown(page: Page, file: string, jsx: "ready" | "error" | null = "ready") {
  await card(page, file).scrollIntoViewIfNeeded();
  if (jsx) await expect(doc(page, file).locator("html")).toHaveAttribute("data-cf-jsx", jsx);
  return doc(page, file);
}

/** The computed colour of an element in a card's page. */
const colour = (page: Page, file: string, testId: string, prop = "color") =>
  doc(page, file).getByTestId(testId).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test("a colour or weight utility beats a type role, in both schemes: Badge and Button text, text-body text-cf-error-text", async ({ page }) => {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") await openPages(page);
    await shown(page, "roles");
    await expect.poll(() => colour(page, "roles", "err")).toBe(await colour(page, "roles", "ref-error"));
    expect(await colour(page, "roles", "ok")).toBe(await colour(page, "roles", "ref-success"));
    expect(await colour(page, "roles", "normal", "font-weight")).toBe("400");
    expect(await colour(page, "roles", "bold", "font-weight")).toBe("600");
    // Badge and Button text is the accent's foreground (primary-foreground), not the role's text colour.
    const onAccent = await colour(page, "roles", "ref-on-accent");
    expect(await colour(page, "roles", "badge")).toBe(onAccent);
    expect(await colour(page, "roles", "button")).toBe(onAccent);
    // Not the caption role's muted colour (the destructive Badge is foreground on dark, its own on light).
    expect(await colour(page, "roles", "badge-destructive")).not.toBe(await colour(page, "roles", "ref-muted"));
  }
  await page.emulateMedia({ colorScheme: null });
  await snap(page, "roles");
});

test("an indeterminate Checkbox draws a dash, and strings that read like imports are left alone", async ({ page }) => {
  await openPages(page);
  const roles = await shown(page, "roles");
  const mixed = roles.getByTestId("mixed");
  await expect(mixed).toHaveAttribute("aria-checked", "mixed");
  await expect(mixed.locator("svg.lucide-minus")).toBeVisible();
  await expect(mixed.locator("svg.lucide-check")).toBeHidden();
  await expect(roles.getByTestId("strings")).toHaveText(`copied from "/tmp/report.txt" | run: import './setup.js' first`);
});

test("the card shows a margin around the page's only child, and the error box whole", async ({ page }) => {
  await openPages(page);
  // A frame is as tall as its page asks (the bridge's cf:resize).
  const fits = async (file: string, selector: string) => {
    const frame = card(page, file).getByTestId("thread-html-frame");
    const height = await frame.evaluate((el) => el.getBoundingClientRect().height);
    const bottom = await doc(page, file).locator(selector).first().evaluate((el) => el.getBoundingClientRect().bottom + parseFloat(getComputedStyle(el).marginBottom));
    return height - bottom;
  };
  await shown(page, "margin", null);
  await expect.poll(() => fits("margin", '[data-testid="boxed"]')).toBeGreaterThanOrEqual(-0.5);
  expect(await doc(page, "margin").getByTestId("boxed").evaluate((el) => getComputedStyle(el).marginBottom)).toBe("12px");
  await shown(page, "broken", "error");
  await expect.poll(() => fits("broken", "[data-cf-jsx-error]")).toBeGreaterThanOrEqual(-0.5);
  await snap(page, "margin");
});

test("ui.css with the Tailwind runtime keeps the theme's border colour", async ({ page }) => {
  await openPages(page);
  await shown(page, "both");
  const cardEl = doc(page, "both").locator('[data-slot="card"]');
  await expect.poll(() => cardEl.evaluate((el) => getComputedStyle(el).width)).toBe("260px");
  const border = await colour(page, "both", "ref-border");
  expect(await cardEl.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(border);
  await snap(page, "both");
});

test("errors name the page's file and line: a mismatched tag, a syntax error, a render that throws", async ({ page }) => {
  await openPages(page);
  const mismatch = (await shown(page, "mismatch", "error")).locator("[data-cf-jsx-error]");
  await expect(mismatch).toContainText("Syntax error in mismatch.html");
  // `<b>bold</div>` is line 14 of mismatch.html.
  await expect(mismatch).toContainText("</div> closes <b>, opened at 14:8; expected </b> (14:15)");
  await expect(mismatch).toContainText("14 |         <b>bold</div>");
  // broken.html's unclosed div is its line 11.
  const broken = (await shown(page, "broken", "error")).locator("[data-cf-jsx-error]");
  await expect(broken).toContainText("Syntax error in broken.html");
  await expect(broken).toContainText("(11:");
  await expect(broken).toContainText("11 |   const App = () => <div>unclosed;");
  // A render that throws keeps its message, and its frame is the page's file.
  const thrown = (await shown(page, "throw", null)).locator("[data-cf-jsx-error]");
  await expect(thrown).toContainText("render exploded");
  await expect(thrown).toContainText("throw.html:12");
  await expect(thrown).not.toContainText("blob:");
  await snap(page, "mismatch");
});

test("a page pinned to light stays light in the dark app, and its type follows the root font-size", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openPages(page);
  const pinned = await shown(page, "pinned", null);
  const text = pinned.getByTestId("text");
  await expect.poll(() => pinned.locator("html").evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");
  const light = await pinned.locator("html").evaluate((el) => getComputedStyle(el).backgroundColor);
  // 15px body text at an 18px root.
  expect(await text.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16.875px");
  // A theme switch to light and back leaves it light.
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(300);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  expect(await pinned.locator("html").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(light);
  expect(await pinned.locator("html").evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");
  await page.emulateMedia({ colorScheme: null });
});
