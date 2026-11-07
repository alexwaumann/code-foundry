import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

/**
 * The thread header (docs/notes/thread-header-crumb.md): the crumb (where the thread
 * runs, then its parent) and the title menu on the left, the three toggles on the right,
 * over the mock's POST /__mock/thread-info scenarios; the side panel's "+" without the
 * removed surfaces; the card's Changes row opening the Diff tab.
 */

async function open(page: Page, scenario: string): Promise<string> {
  const { id } = (await mockPost(`thread-info?scenario=${scenario}`)) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  return id;
}

const header = (page: Page) => page.getByTestId("thread-header");

test.beforeEach(async () => {
  await resetMock();
});

// The crumb of each kind of thread (one project, a named workspace, an unnamed set, no project:
// icon, place, title, no parent) and the right side being the three toggles: src/components/thread/ThreadParts.test.tsx
// ("the thread header's crumb", "is the three toggles only"). The removed header controls' test ids are gone from src.

// A child's crumb naming its parent, which opens: src/components/thread/ThreadParts.test.tsx ("a child:
// the place, then its parent", "a child's crumb reads place, creator, title"); the card's lineage row
// opening the child: src/components/threadinfo/ThreadInfoCard.test.tsx.

// The title menu's items, Pin -> thread.pin, Unpin, Enter and Escape, the row menu's items:
// ThreadMenuItems.test.tsx and ThreadParts.test.tsx; the pinned glyph: SidebarRow.test.tsx.
test("the title menu: a pick gives the keyboard back to the thread's prompt", async ({ page }) => {
  await open(page, "single");
  const title = header(page).getByTestId("thread-title");
  await title.click();
  await page.getByTestId("thread-title-menu").getByTestId("menu-pin").click();
  await expect(page.getByTestId("thread-title-menu")).toHaveCount(0);
  // The keyboard goes to the prompt, as the header's old Pin button left it.
  await expect(threadPrompt(page)).toBeFocused();
});

// The side panel's + without the removed surfaces: src/components/panel/SidePanel.test.tsx ("an empty
// panel's + lists File, Diff and Pull request"). The card's Changes row opening the Diff tab:
// ThreadInfoCard.test.tsx ("the git group"); its totals and a file opening its Diff tab:
// src/components/diff/DiffView.test.tsx.
