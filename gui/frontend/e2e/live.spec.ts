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
 * LIVE_APP_URL, LIVE_MODEL (default opus), LIVE_SHOTS (screenshot dir; unset = no
 * screenshots).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { row, threadPrompt } from "./fixtures";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const ROOT = path.resolve(process.cwd(), "../..");
const BIN = process.env.LIVE_BIN ?? path.join(ROOT, "bin/code-foundry");
const WORKTREE = process.env.LIVE_WORKTREE ?? ROOT;
const SHOTS = process.env.LIVE_SHOTS ?? "";
// Model for the watched turn (LIVE_MODEL, default opus; haiku keeps a test run cheap).
const MODEL = process.env.LIVE_MODEL ?? "opus";

interface LiveThread {
  id: string;
  state?: string;
  status?: string;
  statusReason?: string;
  disconnectReason?: string;
  claudeSessionId?: string;
}

function cli(...args: string[]): string {
  return execFileSync(BIN, args, {
    env: { ...process.env, CODE_FOUNDRY_HOME: HOME },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function listThreads(): LiveThread[] {
  return (
    (
      JSON.parse(cli("thread", "list", "--json")) as {
        threads?: LiveThread[];
      }
    ).threads ?? []
  );
}

function threadInfo(id: string): LiveThread | undefined {
  return listThreads().find((s) => s.id === id);
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
    const w = window as unknown as {
      __badgeLog: string[];
      __badgeTimer?: number;
    };
    w.__badgeLog = [];
    if (w.__badgeTimer) clearInterval(w.__badgeTimer);
    w.__badgeTimer = window.setInterval(() => {
      const v =
        document.querySelector(sel)?.getAttribute("data-session-badge") ?? "";
      if (v && w.__badgeLog.at(-1) !== v) w.__badgeLog.push(v);
    }, 50);
  }, `[data-row-key="s:${id}"] [data-session-badge]`);
}

async function badgeLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __badgeLog: string[] }).__badgeLog,
  );
}

/** The selected thread's pane. */
function pane(page: Page) {
  return page.getByTestId("thread-pane");
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("thread-list")).toBeVisible({
    timeout: 15_000,
  });
}

test.skip(
  !LIVE,
  "live daemon e2e: set LIVE_DAEMON=1 (see playwright.live.config.ts)",
);

test("sessions end to end against the real daemon", async ({ page }) => {
  expect(HOME, "CODE_FOUNDRY_HOME").not.toBe("");
  const created: string[] = [];
  try {
    // (a) A session created from the CLI shows up in the sidebar, idle.
    const s1 = JSON.parse(
      cli("thread", "new", "--worktree", WORKTREE, "--model", MODEL, "--json"),
    ) as LiveThread;
    created.push(s1.id);
    await test.step("a: CLI-created session is listed idle", async () => {
      await openApp(page);
      await expect(row(page, `s:${s1.id}`)).toBeVisible();
      await expect(badge(page, s1.id)).toHaveAttribute(
        "data-session-badge",
        "idle",
        { timeout: 30_000 },
      );
    });

    // (b) Selecting it shows the (empty) conversation with the prompt focused.
    await test.step("b: selecting shows the thread, its prompt focused", async () => {
      await row(page, `s:${s1.id}`).click();
      await expect(pane(page)).toHaveAttribute("data-session-id", s1.id);
      await expect(pane(page).getByTestId("thread-empty")).toHaveText(
        "No messages yet.",
      );
      await expect(threadPrompt(page)).toBeFocused();
      await shot(page, "attached.png");
    });

    // (c) A turn while viewed: busy, then idle (never "needs attention"), CLI agrees.
    await test.step("c: a viewed turn ends idle", async () => {
      await recordBadge(page, s1.id);
      await page.keyboard.type("reply with the single word pong");
      await page.keyboard.press("Enter"); // thread.send
      await expect(pane(page).getByTestId("thread-user").last()).toContainText(
        "reply with the single word pong",
      );
      await expect(badge(page, s1.id)).toHaveAttribute(
        "data-session-badge",
        "busy",
        { timeout: 20_000 },
      );
      await expect(badge(page, s1.id)).toHaveAttribute(
        "data-session-badge",
        "idle",
        { timeout: 90_000 },
      );
      await expect(pane(page).getByTestId("thread-text").last()).toContainText(
        /pong/i,
      );
      await expect(
        pane(page).getByTestId("thread-footer").last(),
      ).toBeVisible();
      await page.waitForTimeout(1500); // let a late "finished" show, if the rule were broken
      const log = await badgeLog(page);
      expect(log).toContain("busy");
      expect(log).not.toContain("attention");
      expect(log.at(-1)).toBe("idle");
      await expect
        .poll(() => threadInfo(s1.id)?.status)
        .toBe("THREAD_STATUS_IDLE");
      await expect(page).toHaveTitle("Code Foundry");
    });

    // (c') The other half of the rule: a turn nobody watches ends as needs-attention
    // "finished" in the CLI; showing the session in the GUI clears it to idle.
    await test.step("c': an unwatched turn needs attention until viewed", async () => {
      await page.goto("about:blank"); // no GUI attached (thread.new would focus it)
      const s2 = JSON.parse(
        cli(
          "thread",
          "new",
          "--worktree",
          WORKTREE,
          "--model",
          "haiku",
          "--name",
          "unwatched",
          "--prompt",
          "reply with the single word ping",
          "--json",
        ),
      ) as LiveThread;
      created.push(s2.id);
      await expect
        .poll(
          () => {
            const s = threadInfo(s2.id);
            return `${s?.status ?? ""} ${s?.statusReason ?? ""}`;
          },
          { timeout: 90_000 },
        )
        .toBe("THREAD_STATUS_NEEDS_ATTENTION finished");
      expect(cli("thread", "list")).toMatch(
        /unwatched\s+needs_attention\s+finished/,
      );
      await openApp(page);
      await expect(badge(page, s2.id)).toHaveAttribute(
        "data-session-badge",
        "attention",
      );
      await expect(page).toHaveTitle("Code Foundry (1)");
      await row(page, `s:${s2.id}`).click();
      await expect(pane(page).getByTestId("thread-user").first()).toContainText(
        "reply with the single word ping",
      );
      await expect(badge(page, s2.id)).toHaveAttribute(
        "data-session-badge",
        "idle",
      );
      await expect
        .poll(() => threadInfo(s2.id)?.status)
        .toBe("THREAD_STATUS_IDLE");
      await expect(page).toHaveTitle("Code Foundry");
    });

    // (d) Archiving from the CLI stops Claude; the pane looks the same (no card, the
    // composer), and a message starts it again with the conversation kept.
    await test.step("d: a stopped thread keeps its composer; a message continues it", async () => {
      await row(page, `s:${s1.id}`).click();
      await expect(pane(page)).toHaveAttribute("data-session-id", s1.id);
      cli("thread", "archive", "--id", s1.id, "--yes");
      await expect
        .poll(() => threadInfo(s1.id)?.state, { timeout: 20_000 })
        .toBe("THREAD_STATE_DISCONNECTED");
      await expect(page.getByTestId("thread-disconnected")).toHaveCount(0);
      await expect(page.getByTestId("thread-composer")).toBeVisible();
      await expect(pane(page)).not.toContainText(/Not connected|Reconnect/);
      await shot(page, "stopped.png");
      await page.getByTestId("thread-composer").getByTestId("composer-input").click();
      await page.keyboard.type("reply with the single word ping");
      await page.keyboard.press("Enter");
      await expect(pane(page).getByTestId("thread-user").first()).toContainText(
        "reply with the single word pong",
      );
      await expect(pane(page).getByTestId("thread-text").last()).toContainText(
        /ping/i,
        { timeout: 60_000 },
      );
      await expect(badge(page, s1.id)).toHaveAttribute(
        "data-session-badge",
        /^(idle|attention)$/,
        { timeout: 30_000 },
      );
    });

    // (e) cmd+n (from the focused prompt) opens the project picker, then the new-thread
    // composer for the picked project; Escape leaves without creating anything.
    await test.step("e: cmd+n opens the picker, then the composer", async () => {
      const before = listThreads().length;
      await threadPrompt(page).click();
      await page.keyboard.press("Meta+n");
      const palette = page.getByTestId("palette");
      await expect(palette).toHaveAttribute("data-mode", "projects");
      await page.waitForTimeout(400); // let the palette's open animation finish
      await shot(page, "new-thread-picker.png");
      await page.keyboard.press("Enter");
      await expect(palette).toHaveCount(0);
      await expect(page.getByTestId("composer-heading")).toContainText(
        "What should we build in",
      );
      await expect(page.getByTestId("composer-input")).toBeFocused();
      await page.getByTestId("composer-model").click();
      const models = page
        .getByTestId("composer-model-list")
        .getByRole("option");
      for (const m of ["Fable", "Opus", "Sonnet", "Haiku"])
        await expect(models.filter({ hasText: m }).first()).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      expect(listThreads()).toHaveLength(before); // nothing was created
    });

    // (f) `session focus` from the CLI selects the session in the GUI.
    await test.step("f: CLI focus selects the session", async () => {
      await row(page, `s:${created[1] ?? ""}`).click();
      await expect(row(page, `s:${created[1] ?? ""}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(cli("thread", "focus", "--id", s1.id)).toMatch(/delivered=[1-9]/);
      await expect(row(page, `s:${s1.id}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(pane(page)).toHaveAttribute("data-session-id", s1.id);
    });
  } finally {
    for (const id of created) {
      if (threadInfo(id)?.state !== "THREAD_STATE_DISCONNECTED")
        cli("thread", "archive", "--id", id, "--yes");
    }
    // For the caller's cleanup of ~/.claude/projects/<slug>/<id>.jsonl.
    console.log(
      "live sessions:",
      JSON.stringify(
        listThreads().map((s) => ({
          id: s.id,
          claudeSessionId: s.claudeSessionId,
        })),
      ),
    );
  }
});
