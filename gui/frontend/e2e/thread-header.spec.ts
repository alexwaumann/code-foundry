import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";
import { openHeaderMenu } from "./shell-threads";

/**
 * The thread header (docs/notes/thread-header-crumb.md) over the mock's POST
 * /__mock/thread-info scenarios: the header's menu giving the keyboard back. The rest is
 * unit-tested (the comments below say where). In the shell the header is the branch chip, the
 * thread info toggle and one menu (docs/notes/shell-model.md, "The thread's header").
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
  await expect(threadPrompt(page)).toBeFocused();
  // The shell's header has one menu (ThreadHeader): the thread's items, Pin among them.
  const menu = await openHeaderMenu(page, header(page));
  await menu.getByTestId("menu-pin").click();
  await expect(menu).toHaveCount(0);
  // The keyboard goes to the prompt, as the header's old Pin button left it.
  await expect(threadPrompt(page)).toBeFocused();
});

// The pane's + menu with a thread's surfaces: src/components/shell/linkedTabs.test.tsx. The card's
// Changes row opening the Diff tab:
// ThreadInfoCard.test.tsx ("the git group"); its totals and a file opening its Diff tab:
// src/components/diff/DiffView.test.tsx.
