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

// The row's Error and "transcript deleted" (SidebarRow.test.tsx), the header chip after the title
// (ThreadParts.test.tsx), the note's text and its Archive and Remove (TranscriptDeleted.test.tsx),
// no cold-cache line, the prompt disabled with its placeholder, Send and Attach disabled
// (ThreadComposer.test.tsx): unit-tested. Left here: the real editor taking no typing and Enter
// sending nothing.
test("nothing can be typed or sent in its prompt", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-3");
  const prompt = threadPrompt(page);
  await expect(prompt).toHaveAttribute("aria-disabled", "true");
  // Not editable: a click (forced, Playwright sees it is disabled) and typing change nothing.
  await prompt.click({ force: true });
  await page.keyboard.type("still there?");
  await page.keyboard.press("Enter");
  await expect(prompt).not.toContainText("still there?");
  await expect(page.getByTestId("thread-send")).toBeDisabled();
  expect((await invocations()).filter((i) => i.name === "thread.send")).toEqual([]);
});

// Fork disabled in the row menu: unit-tested in src/components/sidebar/RowMenu.test.tsx

// Archive and Remove running the thread actions, an archived thread offering Remove only:
// src/components/thread/TranscriptDeleted.test.tsx; archiving the selected thread selecting home:
// e2e/archive.spec.ts; Remove's confirm: the daemon's (ConfirmDialog.test.tsx renders it).
