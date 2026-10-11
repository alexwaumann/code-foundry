/**
 * Live e2e: the GUI against a real daemon running real Claude Code. Opt-in (LIVE_DAEMON=1)
 * and run with playwright.live.config.ts, which starts nothing: bring up an isolated
 * daemon (CODE_FOUNDRY_HOME), register the worktree, and run the Vite dev server pointed
 * at it first (recipe in docs/notes/phase2-integration.md).
 *
 * It spends two short Claude turns (opus "pong", haiku "ping"), writes their transcripts
 * under ~/.claude/projects/, and closes its sessions at the end.
 *
 * Env: LIVE_DAEMON=1, CODE_FOUNDRY_HOME (required); LIVE_BIN, LIVE_WORKTREE,
 * LIVE_APP_URL, LIVE_SHOTS (screenshot dir; unset = no screenshots).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectTerminalText, row } from "./fixtures";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const ROOT = path.resolve(process.cwd(), "../..");
const BIN = process.env.LIVE_BIN ?? path.join(ROOT, "bin/code-foundry");
const WORKTREE = process.env.LIVE_WORKTREE ?? ROOT;
const SHOTS = process.env.LIVE_SHOTS ?? "";

interface LiveSession {
  id: string;
  terminalId?: string;
  state?: string;
  status?: string;
  statusReason?: string;
  disconnectReason?: string;
  claudeSessionId?: string;
}

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 30_000 });
}

function listSessions(): LiveSession[] {
  return (JSON.parse(cli("session", "list", "--json")) as { sessions?: LiveSession[] }).sessions ?? [];
}

function sessionInfo(id: string): LiveSession | undefined {
  return listSessions().find((s) => s.id === id);
}

function badge(page: Page, id: string) {
  return row(page, `s:${id}`).locator("[data-session-badge]");
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
}

/** Records every distinct badge value of a session row, sampled every 50 ms in the page. */
async function recordBadge(page: Page, id: string): Promise<void> {
  await page.evaluate((sel) => {
    const w = window as unknown as { __badgeLog: string[]; __badgeTimer?: number };
    w.__badgeLog = [];
    if (w.__badgeTimer) clearInterval(w.__badgeTimer);
    w.__badgeTimer = window.setInterval(() => {
      const v = document.querySelector(sel)?.getAttribute("data-session-badge") ?? "";
      if (v && w.__badgeLog.at(-1) !== v) w.__badgeLog.push(v);
    }, 50);
  }, `[data-row-key="s:${id}"] [data-session-badge]`);
}

async function badgeLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __badgeLog: string[] }).__badgeLog);
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("thread-list")).toBeVisible({ timeout: 15_000 });
}

test.skip(!LIVE, "live daemon e2e: set LIVE_DAEMON=1 (see playwright.live.config.ts)");

test("sessions end to end against the real daemon", async ({ page }) => {
  expect(HOME, "CODE_FOUNDRY_HOME").not.toBe("");
  const created: string[] = [];
  try {
    // (a) A session created from the CLI shows up in the sidebar, idle.
    const s1 = JSON.parse(cli("session", "new", "--worktree", WORKTREE, "--model", "opus", "--json")) as LiveSession;
    created.push(s1.id);
    await test.step("a: CLI-created session is listed idle", async () => {
      await openApp(page);
      await expect(row(page, `s:${s1.id}`)).toBeVisible();
      await expect(badge(page, s1.id)).toHaveAttribute("data-session-badge", "idle", { timeout: 30_000 });
    });

    // (b) Selecting it attaches and shows Claude's prompt UI.
    await test.step("b: selecting attaches Claude's UI", async () => {
      await row(page, `s:${s1.id}`).click();
      const host = page.getByTestId("terminal-host");
      await expect(host).toHaveAttribute("data-attach-phase", "live");
      await expectTerminalText(page, /❯/);
      await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", sessionInfo(s1.id)?.terminalId ?? "?");
      await shot(page, "attached.png");
    });

    // (c) A turn while viewed: busy, then idle (never "needs attention"), CLI agrees.
    await test.step("c: a viewed turn ends idle", async () => {
      await recordBadge(page, s1.id);
      await page.keyboard.type("reply with the single word pong", { delay: 15 });
      await page.waitForTimeout(700); // stay clear of Claude's paste detection
      await page.keyboard.press("Enter");
      await expect(badge(page, s1.id)).toHaveAttribute("data-session-badge", "busy", { timeout: 20_000 });
      await expect(badge(page, s1.id)).toHaveAttribute("data-session-badge", "idle", { timeout: 90_000 });
      await expectTerminalText(page, /⏺\s*pong/i);
      await page.waitForTimeout(1500); // let a late "finished" show, if the rule were broken
      const log = await badgeLog(page);
      expect(log).toContain("busy");
      expect(log).not.toContain("attention");
      expect(log.at(-1)).toBe("idle");
      await expect.poll(() => sessionInfo(s1.id)?.status).toBe("SESSION_STATUS_IDLE");
      await expect(page).toHaveTitle("Code Foundry");
    });

    // (c') The other half of the rule: a turn nobody watches ends as needs-attention
    // "finished" in the CLI; showing the session in the GUI clears it to idle.
    await test.step("c': an unwatched turn needs attention until viewed", async () => {
      await page.goto("about:blank"); // no GUI attached (session.new would focus it)
      const s2 = JSON.parse(
        cli("session", "new", "--worktree", WORKTREE, "--model", "haiku", "--name", "unwatched", "--prompt", "reply with the single word ping", "--json"),
      ) as LiveSession;
      created.push(s2.id);
      await expect
        .poll(() => {
          const s = sessionInfo(s2.id);
          return `${s?.status ?? ""} ${s?.statusReason ?? ""}`;
        }, { timeout: 90_000 })
        .toBe("SESSION_STATUS_NEEDS_ATTENTION finished");
      expect(cli("session", "list")).toMatch(/unwatched\s+connected\s+needs_attention\s+finished/);
      await openApp(page);
      await expect(badge(page, s2.id)).toHaveAttribute("data-session-badge", "attention");
      await expect(page).toHaveTitle("Code Foundry (1)");
      await row(page, `s:${s2.id}`).click();
      await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
      await expect(badge(page, s2.id)).toHaveAttribute("data-session-badge", "idle");
      await expect.poll(() => sessionInfo(s2.id)?.status).toBe("SESSION_STATUS_IDLE");
      await expect(page).toHaveTitle("Code Foundry");
    });

    // (d) Closing from the CLI flips the pane to "Not connected"; Reconnect resumes.
    await test.step("d: CLI close shows Not connected; Reconnect resumes", async () => {
      await row(page, `s:${s1.id}`).click();
      await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
      cli("session", "close", "--id", s1.id);
      const panel = page.getByTestId("session-disconnected");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("disconnect-reason")).toHaveText("closed");
      await expect(badge(page, s1.id)).toHaveAttribute("data-session-badge", "disconnected");
      await shot(page, "not-connected.png");
      await panel.getByTestId("reconnect").click();
      const host = page.getByTestId("terminal-host");
      await expect(host).toHaveAttribute("data-attach-phase", "live", { timeout: 20_000 });
      await expectTerminalText(page, /reply with the single word pong/);
      await expectTerminalText(page, /⏺\s*pong/i);
      await expect(badge(page, s1.id)).toHaveAttribute("data-session-badge", "idle", { timeout: 30_000 });
    });

    // (e) cmd+n (from the focused terminal) opens session.new's prompts: model, effort.
    await test.step("e: cmd+n prompts model then effort", async () => {
      const before = listSessions().length;
      await page.getByTestId("terminal-host").click();
      await page.keyboard.press("Meta+n");
      const palette = page.getByTestId("palette");
      await expect(palette).toHaveAttribute("data-mode", "args");
      const option = (v: string) => palette.getByRole("option", { name: new RegExp(`^${v}( default)?$`) });
      for (const m of ["fable", "opus", "sonnet", "haiku"]) await expect(option(m)).toBeVisible();
      await page.waitForTimeout(400); // let the palette's open animation finish
      await shot(page, "new-session-palette.png");
      await option("sonnet").click();
      for (const e of ["low", "medium", "high", "xhigh", "max"]) await expect(option(e)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      expect(listSessions()).toHaveLength(before); // nothing was created
    });

    // (f) `session focus` from the CLI selects the session in the GUI.
    await test.step("f: CLI focus selects the session", async () => {
      await row(page, `s:${created[1] ?? ""}`).click();
      await expect(row(page, `s:${created[1] ?? ""}`)).toHaveAttribute("aria-selected", "true");
      expect(cli("session", "focus", "--id", s1.id)).toMatch(/delivered=[1-9]/);
      await expect(row(page, `s:${s1.id}`)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", sessionInfo(s1.id)?.terminalId ?? "?");
    });
  } finally {
    for (const id of created) {
      if (sessionInfo(id)?.state !== "SESSION_STATE_DISCONNECTED") cli("session", "close", "--id", id);
    }
    // For the caller's cleanup of ~/.claude/projects/<slug>/<id>.jsonl.
    console.log("live sessions:", JSON.stringify(listSessions().map((s) => ({ id: s.id, claudeSessionId: s.claudeSessionId }))));
  }
});
