import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

/**
 * The thread header (docs/notes/thread-header-crumb.md): the crumb (where the thread
 * runs, then its parent) and the title menu on the left, the three toggles on the right,
 * over the mock's POST /__mock/thread-info scenarios; the side panel's "+" without the
 * removed surfaces; the card's Changes row opening the Changes tab.
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

test("a child's crumb names its parent, which opens on a click", async ({ page }) => {
  // A child has no sidebar row: open it from its parent's thread info card.
  await mockPost("thread-info?scenario=child");
  await openApp(page);
  await row(page, "s:s-ti-1").click();
  await page.getByTestId("thread-info-toggle").click();
  await page.getByTestId("thread-info-card").locator('[data-testid="ti-lineage-row"][data-id="s-ti-child"]').click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ti-child");
  const h = header(page);
  await expect(h.getByTestId("thread-crumb-place")).toHaveText("code-foundry");
  await expect(h.getByTestId("thread-crumb-parent")).toHaveText("Fix the stale PR badge");
  await expect(h.getByTestId("thread-title-name")).toHaveText("Port the rotation to web");
  await h.getByTestId("thread-crumb-parent").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ti-1");
  await expect(header(page).getByTestId("thread-crumb-parent")).toHaveCount(0);
});

test("the title menu: the sidebar row's items; Pin pins the thread", async ({ page }) => {
  const id = await open(page, "single");
  const title = header(page).getByTestId("thread-title");
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByTestId("thread-title-menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Rename", "Regenerate name", "Pin", "Snooze", "New thread on this branch", "Archive"]);
  await menu.getByTestId("menu-pin").click();
  await expect(menu).toHaveCount(0);
  // The keyboard goes to the prompt, as the header's old Pin button left it.
  await expect(threadPrompt(page)).toBeFocused();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.pin").map((i) => i.args.pinned)).toEqual(["true"]);
  await expect(row(page, `s:${id}`).getByTestId("row-pinned")).toBeVisible();

  // The keyboard opens it too, and it now offers Unpin; Escape closes it.
  await title.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-title-menu").getByTestId("menu-pin")).toHaveText("Unpin");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-title-menu")).toHaveCount(0);

  // The sidebar row's context menu starts with the same items.
  await row(page, `s:${id}`).click({ button: "right" });
  await expect(page.getByTestId("row-menu").getByRole("menuitem").first()).toHaveText("Rename");
  await expect(page.getByTestId("row-menu").getByRole("menuitem")).toHaveText(["Rename", "Regenerate name", "Unpin", "Snooze", "New thread on this branch", "Archive", "New terminal here", "Fork", "Remove"]);
});

test("the side panel's + lists none of the removed surfaces", async ({ page }) => {
  await open(page, "single");
  await page.getByTestId("panel-toggle").click();
  const empty = page.getByTestId("side-panel").getByTestId("panel-empty");
  await expect(empty).toBeVisible();
  const entries = empty.locator('[data-surface]:not([data-surface^="plugin."])');
  await expect(entries).toHaveText(["FileF", "DiffD", "Pull requestP"]);
  for (const gone of ["usage", "linkedprs", "threads", "agents", "worktree", "mcp", "changes"]) await expect(empty.locator(`[data-surface="${gone}"]`)).toHaveCount(0);
});

test("the card's Changes row opens the Changes tab", async ({ page }) => {
  await open(page, "single");
  await page.getByTestId("thread-info-toggle").click();
  await page.getByTestId("thread-info-card").getByTestId("ti-changes").click();
  const body = page.getByTestId("panel-body");
  await expect(body).toHaveAttribute("data-surface", "changes");
  await expect(body.getByTestId("changes-totals")).toHaveText("4 files · +42 −9");
  // Only the lists: the old Worktree tab's header, facts and pull request row are gone.
  await expect(body.getByTestId("worktree-surface-header")).toHaveCount(0);
  await body.getByTestId("file-name").first().click();
  await expect(body).toHaveAttribute("data-surface", "diff");
});
