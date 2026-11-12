/**
 * Live e2e: a skill tag from the composer's "/" card, against a REAL daemon and real Claude
 * Code (docs/notes/composer-tags-3-skills.md). Opt-in; how to run it: docs/notes/live-e2e.md.
 * The scratch project (LIVE_PROJECT, else the first registered; under ~: ListSkills only reads
 * checkouts under home) has `.claude/skills/<LIVE_SKILL, default demo>/SKILL.md`; with
 * LIVE_SKILL_REPLY set, the skill tells Claude to reply with that word.
 *
 * It spends one short turn, waits for Claude's answer in the transcript, checks the skill ran
 * (its reply, when LIVE_SKILL_REPLY is set), and archives the thread.
 */
import { expect, test } from "@playwright/test";
import { answerLines, archiveThreads, composeIn, liveProject, openApp, pickCheapModel, requireLive, selectedThreadId, shot, threadInfo, transcript } from "./live";

const SKILL = process.env.LIVE_SKILL ?? "demo";
const REPLY = process.env.LIVE_SKILL_REPLY ?? "";

requireLive();

test("composer: a /skill tag from the card starts a thread that runs the skill", async ({ page }) => {
  await openApp(page);
  await composeIn(page, { project: liveProject().id });
  await pickCheapModel(page);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type(`/${SKILL.slice(0, 3)}`);
  const card = page.getByTestId("completion-card");
  await expect(card.getByTestId("completion-item").filter({ hasText: `/${SKILL}` })).toBeVisible();
  await shot(page, "live-skills-card");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-tag")).toHaveText([`/${SKILL}`]);
  await page.keyboard.type("now");
  await page.getByTestId("prompt-tag").hover();
  await expect(page.getByTestId("prompt-tag-tooltip")).toContainText("Project skill");
  await shot(page, "live-skills-tag");
  await page.keyboard.press("Enter");

  const id = await selectedThreadId(page, 30_000);
  console.log(`live-skills thread ${id}`);
  try {
    // The status reads idle before the first turn starts: wait for Claude's answer in the transcript instead.
    await expect.poll(() => threadInfo(id)?.claudeSessionId ?? "", { timeout: 60_000 }).not.toBe("");
    const text = () => transcript(threadInfo(id)?.claudeSessionId ?? "");
    await expect.poll(() => answerLines(text()).join("\n"), { timeout: 180_000 }).not.toBe("");
    const firstUser = text()
      .split("\n")
      .find((l) => l.includes('"type":"user"'));
    console.log(`first user message: ${firstUser?.slice(0, 400) ?? ""}`);
    // The message Claude got starts the skill: its slash command, not the tag's text.
    expect(firstUser ?? "").toContain(`/${SKILL}`);
    if (REPLY) expect(answerLines(text()).join("\n")).toContain(REPLY);
    await expect.poll(() => threadInfo(id)?.status, { timeout: 60_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
    await shot(page, "live-skills-thread");
  } finally {
    archiveThreads(id);
  }
});
