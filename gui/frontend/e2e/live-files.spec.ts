/**
 * Live e2e: a file tag from the composer's "@" card, against a REAL daemon and real Claude
 * Code (docs/notes/composer-tags-4-files.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon
 * (CODE_FOUNDRY_HOME) with ONE registered project under ~ whose README.md starts with a
 * recognisable line, and the Vite dev server pointed at it (recipe in
 * docs/notes/phase2-integration.md).
 *
 * It types `@READ`, inserts the tag, starts a haiku thread in a new worktree with "print the
 * first line of <tag> and stop", waits for Claude's answer in the transcript, prints the
 * first user message, the Read tool's input and the answer (check that the path is the new
 * worktree's), and closes the thread.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 30_000 });
}

interface LiveSession {
  id: string;
  status?: string;
  claudeSessionId?: string;
  worktreePath?: string;
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

test("composer: an @file tag from the card starts a haiku thread that reads the file in its new worktree", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.getByTestId("composer-model").click();
  await page.getByTestId("composer-model-list").getByRole("option", { name: /Haiku/ }).click();
  await page.getByTestId("composer-effort").click();
  await page.getByTestId("composer-effort-list").getByRole("option", { name: /Medium/ }).click();
  await expect(page.getByTestId("composer-worktree")).toContainText("New worktree");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("print the first line of @READ");
  const card = page.getByTestId("completion-card");
  await expect(card.getByTestId("completion-label").first()).toHaveText("README.md");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-files-card.png") });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-tag")).toHaveText(["README.md"]);
  await page.keyboard.type("and stop");
  await page.getByTestId("prompt-tag").hover();
  await expect(page.getByTestId("prompt-tag-tooltip").locator("p").first()).toHaveText("README.md");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-files-tag.png") });
  await page.keyboard.press("Enter");

  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible({ timeout: 60_000 });
  const id = ((await created.getAttribute("data-row-key")) ?? "").slice(2);
  console.log(`live-files session ${id}`);
  const find = () => ((JSON.parse(cli("session", "list", "--json")) as { sessions?: LiveSession[] }).sessions ?? []).find((s) => s.id === id);
  await expect.poll(() => find()?.claudeSessionId ?? "", { timeout: 60_000 }).not.toBe("");
  console.log(`worktree: ${find()?.worktreePath ?? ""}`);
  const transcript = () => {
    const sid = find()?.claudeSessionId ?? "";
    const root = path.join(os.homedir(), ".claude/projects");
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${sid}.jsonl`);
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    }
    return "";
  };
  const lines = () => transcript().split("\n");
  const answer = () => lines().filter((l) => l.includes('"type":"assistant"') && l.includes('"type":"text"')).join("\n");
  await expect.poll(answer, { timeout: 180_000 }).not.toBe("");
  console.log(`first user message: ${lines().find((l) => l.includes('"type":"user"'))?.slice(0, 600) ?? ""}`);
  for (const l of lines().filter((x) => x.includes('"type":"tool_use"'))) console.log(`tool use: ${l.slice(l.indexOf('"type":"tool_use"'), l.indexOf('"type":"tool_use"') + 300)}`);
  console.log(`answer: ${answer().slice(0, 800)}`);
  await expect.poll(() => find()?.status, { timeout: 60_000 }).toBe("SESSION_STATUS_IDLE");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-files-thread.png") });
  cli("session", "close", "--id", id);
});
