/**
 * Live e2e: a workspace thread started from the composer against a REAL daemon and real
 * Claude Code (docs/notes/workspaces-3-composer.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon
 * (CODE_FOUNDRY_HOME) with two registered repos and one workspace (LIVE_WORKSPACE, its
 * name), and the Vite dev server pointed at it (recipe in docs/notes/phase2-integration.md).
 *
 * It spends one short haiku turn ("say hi and stop") and closes the thread at the end.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const WORKSPACE = process.env.LIVE_WORKSPACE ?? "demo";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 30_000 });
}

interface LiveSession {
  id: string;
  repoId?: string;
  worktreePath?: string;
  workspaceId?: string;
  state?: string;
  status?: string;
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

test("composer: pick a workspace, make the second member primary, start a haiku thread", async ({ page }) => {
  const members = JSON.parse(cli("workspace", "members", WORKSPACE, "--json")) as {
    workspace: { id: string; name: string };
    members: { repoId: string; repoName: string; worktreePath: string }[];
  };
  const second = members.members[1];
  if (!second) throw new Error(`workspace ${WORKSPACE} needs two members`);

  await page.goto("/");
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await palette.locator(`[data-workspace="${members.workspace.id}"]`).click();
  await expect(page.getByTestId("composer-heading")).toHaveText(`What should we build in ${members.workspace.name}?`);
  await page.getByTestId("composer-member").nth(1).getByRole("button").first().click();
  await expect(page.getByTestId("composer-member").nth(1)).toHaveAttribute("data-primary", "true");
  await page.getByTestId("composer-model").click();
  await page.getByTestId("composer-model-list").getByRole("option", { name: /Haiku/ }).click();
  await page.getByTestId("composer-effort").click();
  await page.getByTestId("composer-effort-list").getByRole("option", { name: /Medium/ }).click();
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("say hi and stop");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-workspace-composer.png") });
  await page.keyboard.press("Enter");

  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible({ timeout: 30_000 });
  const id = ((await created.getAttribute("data-row-key")) ?? "").slice(2);
  const find = () => ((JSON.parse(cli("session", "list", "--json")) as { sessions?: LiveSession[] }).sessions ?? []).find((s) => s.id === id);
  expect(find()).toMatchObject({ workspaceId: members.workspace.id, repoId: second.repoId, worktreePath: second.worktreePath });
  await expect.poll(() => find()?.status, { timeout: 120_000 }).toBe("SESSION_STATUS_IDLE");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-workspace-thread.png") });
  cli("session", "close", "--id", id);
});
