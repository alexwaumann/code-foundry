/**
 * Live e2e: a file tag from the composer's "@" card, against a REAL daemon and real Claude
 * Code (docs/notes/composer-tags-4-files.md). Opt-in; how to run it: docs/notes/live-e2e.md.
 * The scratch project (LIVE_PROJECT, else the first registered) is a git repository whose
 * README.md is its only file starting "READ".
 *
 * It types `@READ`, inserts the tag, picks Fresh copy (a new worktree), starts a thread with
 * "print the first line of <tag> and stop" (one short turn), waits for Claude's answer in the
 * transcript, checks the Read tool read README.md in the new worktree, not the project
 * folder, and archives the thread (the worktree stays, for `project worktree cleanup`).
 */
import { expect, test } from "@playwright/test";
import { answerLines, archiveThreads, composeIn, liveProject, openApp, pickCheapModel, requireLive, selectedThreadId, shot, threadInfo, transcript } from "./live";

requireLive();

test("composer: an @file tag from the card starts a thread that reads the file in its new worktree", async ({ page }) => {
  const project = liveProject();
  await openApp(page);
  await composeIn(page, { project: project.id });
  await pickCheapModel(page);
  await page.getByTestId("composer-worktree").click();
  await page.getByTestId("composer-worktree-list").getByRole("option", { name: /Fresh copy/ }).click();
  await expect(page.getByTestId("composer-worktree")).toContainText("Fresh copy");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("print the first line of @READ");
  const card = page.getByTestId("completion-card");
  await expect(card.getByTestId("completion-label").first()).toHaveText("README.md");
  await shot(page, "live-files-card");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-tag")).toHaveText(["README.md"]);
  await page.keyboard.type("and stop");
  await page.getByTestId("prompt-tag").hover();
  await expect(page.getByTestId("prompt-tag-tooltip").locator("p").first()).toHaveText("README.md");
  await shot(page, "live-files-tag");
  await page.keyboard.press("Enter");

  const id = await selectedThreadId(page);
  console.log(`live-files thread ${id}`);
  try {
    await expect.poll(() => threadInfo(id)?.claudeSessionId ?? "", { timeout: 60_000 }).not.toBe("");
    const worktree = threadInfo(id)?.worktreePath ?? "";
    expect(worktree).not.toBe(project.path);
    const lines = () => transcript(threadInfo(id)?.claudeSessionId ?? "").split("\n");
    await expect.poll(() => answerLines(lines().join("\n")).join("\n"), { timeout: 180_000 }).not.toBe("");
    // The tag names the file in the thread's own checkout.
    const reads = lines().filter((l) => l.includes('"type":"tool_use"') && l.includes('"name":"Read"'));
    expect(reads.join("\n")).toContain(`"file_path":"${worktree}/README.md"`);
    expect(answerLines(lines().join("\n")).join("\n")).toContain(`${project.name} live fixture`);
    await expect.poll(() => threadInfo(id)?.status, { timeout: 60_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
    await shot(page, "live-files-thread");
  } finally {
    archiveThreads(id);
  }
});
