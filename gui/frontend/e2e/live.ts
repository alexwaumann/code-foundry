/**
 * Shared helpers of the opt-in live e2e suite (e2e/live*.spec.ts): the GUI against a REAL
 * daemon on a scratch home, real Claude Code and (for some specs) real `gh`. How to run it,
 * what it needs and what it costs: docs/notes/live-e2e.md. Not part of `make check` or
 * `make gui-e2e`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

export const LIVE = process.env.LIVE_DAEMON === "1";
/** The scratch daemon's home (`make drive DAEMON=dev` exports it through drive.env). */
export const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
export const ROOT = path.resolve(process.cwd(), "../..");
export const BIN = process.env.LIVE_BIN ?? path.join(ROOT, "bin/code-foundry");
/** Screenshot directory; unset, no screenshots. */
export const SHOTS = process.env.LIVE_SHOTS ?? "";
/** Model of the threads the specs start: the cheapest one the app offers that runs off Bedrock too. */
export const MODEL = process.env.LIVE_MODEL ?? "claude-haiku-5-5[1m]";
/** The composer's model option for MODEL. */
export const MODEL_OPTION = process.env.LIVE_MODEL_OPTION ?? "Haiku 5.5";

const realHome = path.join(os.homedir(), ".code-foundry");

/**
 * Skips the file unless the suite is switched on, a scratch home is named and `needs` (env
 * names) are set. Never runs against the user's own home.
 */
export function requireLive(...needs: string[]): void {
  const missing = needs.filter((n) => !process.env[n]);
  test.skip(!LIVE || !HOME || missing.length > 0, `live e2e: LIVE_DAEMON=1, CODE_FOUNDRY_HOME${needs.map((n) => `, ${n}`).join("")} (docs/notes/live-e2e.md)`);
  if (HOME && path.resolve(HOME) === realHome) throw new Error(`live e2e refuses the real home ${realHome}: use a scratch one`);
}

/**
 * Runs the CLI against the scratch daemon. The endpoint, token and thread an agent's
 * environment may carry are dropped: the home alone names the daemon, and nothing the
 * specs start is recorded as made by the calling thread.
 */
export function cli(...args: string[]): string {
  return run(args, 60_000);
}

function run(args: string[], timeout: number): string {
  const env: NodeJS.ProcessEnv = { ...process.env, CODE_FOUNDRY_HOME: HOME };
  delete env.CODE_FOUNDRY_ENDPOINT;
  delete env.CODE_FOUNDRY_TOKEN;
  delete env.CODE_FOUNDRY_THREAD;
  return execFileSync(BIN, args, { env, encoding: "utf8", timeout });
}

/** `thread wait`: until the thread's turn settles (idle or attention), at most `seconds`. */
export function waitThread(id: string, seconds = 150): void {
  run(["thread", "wait", "--id", id, "--for", `${String(seconds)}s`], (seconds + 15) * 1000);
}

/** The CLI's --json output, parsed. */
export function cliJson(...args: string[]): unknown {
  return JSON.parse(cli(...args, "--json"));
}

function homeFile(name: string): string {
  return fs.readFileSync(path.join(HOME, name), "utf8").trim();
}

/** A unary RPC over the daemon's loopback listener, as JSON (`ProjectService/List`). */
export async function rpc<T>(method: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${homeFile("daemon.port")}/codefoundry.v1.${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${homeFile("daemon.token")}` },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${method}: ${String(res.status)}`).toBe(true);
  return (await res.json()) as T;
}

export interface LiveProject {
  id: string;
  name: string;
  path: string;
  git?: boolean;
}

export function listProjects(): LiveProject[] {
  return (cliJson("project", "list") as { projects?: LiveProject[] }).projects ?? [];
}

/** The id of the registered project at dir ("" when none). */
export function projectAt(dir: string): string {
  return listProjects().find((p) => p.path.toLowerCase() === dir.toLowerCase())?.id ?? "";
}

/** The first registered project, or the one LIVE_PROJECT names. */
export function liveProject(): LiveProject {
  const want = process.env.LIVE_PROJECT ?? "";
  const p = listProjects().find((x) => !want || x.name === want || x.id === want);
  if (!p) throw new Error(want ? `no project ${want}` : "register a scratch project first (docs/notes/live-e2e.md)");
  return p;
}

/** A workspace by name, with its projects in member order. */
export function liveWorkspace(name: string): { workspace: { id: string; name: string }; members: LiveProject[] } {
  const w = ((cliJson("workspace", "list") as { workspaces?: { id: string; name: string; members?: string[] }[] }).workspaces ?? []).find((x) => x.name === name);
  if (!w) throw new Error(`no workspace ${name} (docs/notes/live-e2e.md)`);
  const projects = listProjects();
  const members = (w.members ?? []).flatMap((id) => projects.filter((p) => p.id === id));
  return { workspace: { id: w.id, name: w.name }, members };
}

export interface LiveThread {
  id: string;
  name?: string;
  state?: string;
  status?: string;
  statusReason?: string;
  claudeSessionId?: string;
  projectId?: string;
  worktreePath?: string;
  workspaceId?: string;
}

/** Every thread, archived ones too. */
export function listThreads(): LiveThread[] {
  return (cliJson("thread", "list", "--archived", "--limit", "0") as { threads?: LiveThread[] }).threads ?? [];
}

export function threadInfo(id: string): LiveThread | undefined {
  return listThreads().find((t) => t.id === id);
}

/** Archives threads the spec started, ignoring ones already gone. */
export function archiveThreads(...ids: string[]): void {
  for (const id of ids) {
    try {
      cli("thread", "archive", "--id", id, "--archived", "--yes");
    } catch {
      // already gone
    }
  }
}

/** The thread the GUI selected (the row a composer send selects). */
export async function selectedThreadId(page: Page, timeout = 60_000): Promise<string> {
  const selected = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(selected).toBeVisible({ timeout });
  return ((await selected.getAttribute("data-row-key")) ?? "").slice(2);
}

/** Claude's transcript of a session (~/.claude/projects/<slug>/<id>.jsonl), "" until it exists. */
export function transcript(claudeSessionId: string): string {
  if (!claudeSessionId) return "";
  const root = path.join(os.homedir(), ".claude/projects");
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  return "";
}

/** The assistant's text lines of a transcript. */
export function answerLines(text: string): string[] {
  return text.split("\n").filter((l) => l.includes('"type":"assistant"') && l.includes('"type":"text"'));
}

/** The app at `path`, pointed at the scratch daemon through the dev-only query override. */
export async function openApp(page: Page, at = "/"): Promise<void> {
  await page.goto(`${at}?daemon=${encodeURIComponent(`http://127.0.0.1:${homeFile("daemon.port")}`)}&token=${homeFile("daemon.token")}`);
  await expect(page.getByTestId("thread-list")).toBeVisible({ timeout: 20_000 });
}

export async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name.endsWith(".png") ? name : `${name}.png`) });
}

/** cmd+n, then the picker's row of a project (`data-project`) or workspace (`data-workspace`): its composer, the prompt focused. */
export async function composeIn(page: Page, row: { project: string } | { workspace: string }): Promise<void> {
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await palette.locator("project" in row ? `[data-project="${row.project}"]` : `[data-workspace="${row.workspace}"]`).click();
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/** Picks MODEL and medium effort in the open composer. */
export async function pickCheapModel(page: Page): Promise<void> {
  await page.getByTestId("composer-model").click();
  await page.getByTestId("composer-model-list").getByRole("option", { name: MODEL_OPTION }).click();
  await page.getByTestId("composer-effort").click();
  await page.getByTestId("composer-effort-list").getByRole("option", { name: /Medium/ }).click();
}
