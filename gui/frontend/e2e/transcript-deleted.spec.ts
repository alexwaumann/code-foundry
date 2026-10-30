import { expect, test } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// A thread whose transcript Claude Code deleted (docs/notes/transcript-deleted.md): it cannot
// continue. Line 2 and the header say so, and the composer is a note with only Archive and
// Remove: nothing can be typed, attached or sent. s-3 ("Fix resize race") is stopped in the
// default world; the mock flags it as the daemon does.

test.beforeEach(async () => {
  await resetMock();
  await mockPost("thread/transcript?id=s-3");
});

test("line 2, header and composer say it cannot continue; nothing can be sent", async ({ page }) => {
  await openApp(page);
  const r = row(page, "s:s-3");
  const place = r.getByTestId("row-place");
  await expect(place).toHaveAttribute("data-status-line", "transcriptDeleted");
  await expect(r.getByTestId("row-status")).toHaveText("Transcript deleted");
  await expect(r.getByTestId("row-transcript-deleted")).toBeVisible();

  await r.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-3");
  await expect(page.getByTestId("thread-transcript-deleted")).toHaveText("Transcript deleted");
  // In the header's left bar, right after the title, not beside the toggles.
  await expect(page.getByTestId("thread-title-bar").getByTestId("thread-transcript-deleted")).toBeVisible();

  const note = page.getByTestId("thread-transcript-note");
  await expect(note).toContainText("This thread can't continue.");
  await expect(note).toContainText("Claude Code removes transcripts after cleanupPeriodDays (30 days by default)");
  await expect(note.getByRole("button")).toHaveText(["Archive", "Remove"]);
  // No cold cache line: there is no conversation to re-read.
  await expect(page.getByTestId("thread-cold-cache")).toHaveCount(0);

  const prompt = threadPrompt(page);
  await expect(prompt).toHaveAttribute("aria-disabled", "true");
  await expect(prompt).toHaveAttribute("aria-placeholder", "Transcript deleted");
  await expect(page.getByTestId("thread-send")).toBeDisabled();
  await expect(page.getByTestId("thread-attach")).toBeDisabled();
  // Not editable: a click (forced, Playwright sees it is disabled) and typing change nothing.
  await prompt.click({ force: true });
  await page.keyboard.type("still there?");
  await page.keyboard.press("Enter");
  await expect(prompt).not.toContainText("still there?");
  await expect(page.getByTestId("thread-send")).toBeDisabled();
  expect((await invocations()).filter((i) => i.name === "thread.send")).toEqual([]);
});

test("Fork is disabled in the row menu", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(page.getByTestId("menu-fork")).toHaveAttribute("data-disabled", "");
});

test("Archive archives it (home shows, as for any archive); opened again, Remove asks, then forgets it", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  const note = page.getByTestId("thread-transcript-note");
  await note.getByTestId("thread-transcript-archive").click();
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect(page.getByTestId("archived-count")).toHaveText("2");

  // Archived: Remove is what is left.
  await page.getByTestId("archived-header").click();
  await row(page, "s:s-3").click();
  await expect(note.getByTestId("thread-transcript-archive")).toHaveCount(0);
  await note.getByTestId("thread-transcript-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove thread s-3?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  expect((await invocations()).map((i) => i.name)).toEqual(expect.arrayContaining(["thread.archive", "thread.remove"]));
});
