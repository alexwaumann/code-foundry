import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Helpers for the thread specs on the window shell (docs/notes/shell-model.md): reaching a thread
 * that waits on the user (a click on its Needs you row's title opens its popup, a click on the
 * rest of the row opens the thread), and the thread header's one menu.
 */

/** The thread pane showing `id`. */
export const threadPaneOf = (page: Page, id: string): Locator => page.locator(`[data-testid="thread-pane"][data-thread-id="${id}"]`);

/**
 * Opens a thread from its sidebar row, whatever its section: a Needs you row by its first line
 * (project and ask; the title opens the popup instead), any other row by a click. The pointer then
 * leaves the sidebar and the row's card (the Needs you card or the classic one) is waited out.
 */
export async function openRowThread(page: Page, id: string): Promise<void> {
  const r = page.locator(`[data-row-key="s:${id}"]`);
  if ((await r.getAttribute("data-section")) === "needs") {
    // The pointer on the row opens its Needs-you card after a 200ms delay. A click inside that
    // delay can leave the card up after the pointer has gone (about 1 in 30 in WebKit), so the
    // card is let open first; the press then shuts it.
    const line = r.getByTestId("row-line-1");
    await line.hover();
    await expect(page.getByTestId("needs-card")).toBeVisible();
    await line.click();
  } else await r.click();
  await expect(threadPaneOf(page, id)).toBeVisible();
  // Off the row, to the grid's far right (a card sits right of the sidebar, and may lie over the grid's left).
  const grid = await page.getByTestId("shell-grid").boundingBox();
  if (!grid) throw new Error("no shell grid");
  await page.mouse.move(grid.x + grid.width - 24, grid.y + grid.height / 2);
  await expect(page.getByTestId("needs-card")).toHaveCount(0);
  await expect(page.getByTestId("thread-tooltip")).toHaveCount(0);
}

/** Opens the focused thread's header menu (`thread-header-menu`). */
export async function openHeaderMenu(page: Page, scope: Locator | Page = page): Promise<Locator> {
  await scope.getByTestId("thread-header-menu-trigger").first().click();
  const menu = page.getByTestId("thread-header-menu");
  await expect(menu).toBeVisible();
  return menu;
}
