/**
 * Live e2e: a skill tag from the composer's "/" card, against a REAL daemon and real Claude
 * Code (docs/notes/composer-tags-3-skills.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon
 * (CODE_FOUNDRY_HOME) with ONE registered project whose checkout has
 * `.claude/skills/<LIVE_SKILL>/SKILL.md` (the project lives under ~: ListSkills only reads
 * checkouts under home), and the Vite dev server pointed at it (recipe in
 * docs/notes/phase2-integration.md).
 *
 * It spends one short haiku turn, waits for Claude's answer in the transcript, prints the
 * first user message and the answer (check that the skill ran), and closes the thread.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const SKILL = process.env.LIVE_SKILL ?? "demo";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 30_000 });
}

interface LiveSession {
  id: string;
  status?: string;
  claudeSessionId?: string;
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

test("composer: a /skill tag from the card starts a haiku thread that runs the skill", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.getByTestId("composer-model").click();
  await page.getByTestId("composer-model-list").getByRole("option", { name: /Haiku/ }).click();
  await page.getByTestId("composer-effort").click();
  await page.getByTestId("composer-effort-list").getByRole("option", { name: /Medium/ }).click();
  await page.getByTestId("composer-input").click();
  await page.keyboard.type(`/${SKILL.slice(0, 3)}`);
  const card = page.getByTestId("completion-card");
  await expect(card.getByTestId("completion-item").filter({ hasText: `/${SKILL}` })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-skills-card.png") });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-tag")).toHaveText([`/${SKILL}`]);
  await page.keyboard.type("now");
  await page.getByTestId("prompt-tag").hover();
  await expect(page.getByTestId("prompt-tag-tooltip")).toContainText("Project skill");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-skills-tag.png") });
  await page.keyboard.press("Enter");

  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible({ timeout: 30_000 });
  const id = ((await created.getAttribute("data-row-key")) ?? "").slice(2);
  console.log(`live-skills session ${id}`);
  const find = () => ((JSON.parse(cli("session", "list", "--json")) as { sessions?: LiveSession[] }).sessions ?? []).find((s) => s.id === id);
  // The status reads idle before the first turn starts: wait for Claude's answer in the
  // transcript (~/.claude/projects/<slug>/<claude session id>.jsonl) instead.
  await expect.poll(() => find()?.claudeSessionId ?? "", { timeout: 30_000 }).not.toBe("");
  const transcript = () => {
    const sid = find()?.claudeSessionId ?? "";
    const root = path.join(os.homedir(), ".claude/projects");
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${sid}.jsonl`);
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    }
    return "";
  };
  const answer = () =>
    transcript()
      .split("\n")
      .filter((l) => l.includes('"type":"assistant"') && l.includes('"type":"text"'))
      .join("\n");
  await expect.poll(answer, { timeout: 180_000 }).not.toBe("");
  const firstUser = transcript()
    .split("\n")
    .find((l) => l.includes('"type":"user"'));
  console.log(`first user message: ${firstUser?.slice(0, 400) ?? ""}`);
  console.log(`answer: ${answer().slice(0, 600)}`);
  await expect.poll(() => find()?.status, { timeout: 60_000 }).toBe("SESSION_STATUS_IDLE");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-skills-thread.png") });
  cli("session", "archive", "--id", id, "--yes");
});
