/**
 * Live e2e: a code block's "Run in terminal" against a REAL daemon and real Claude Code
 * (docs/notes/code-block-actions.md). Opt-in; how to run it: docs/notes/live-e2e.md. The
 * thread is LIVE_THREAD (its last reply has a bash block running `echo run-$((6*7))` and
 * `pwd`, and it owns no shells yet), else one it starts in the scratch project, asks for
 * that block (one short turn) and archives at the end.
 *
 * It hovers the block (Copy and Run show), clicks Run: one new shell in the thread's
 * bottom panel, with the keyboard, that ran both lines once (each echoed once, after the
 * prompt) and is still running afterwards. With LIVE_SHOTS it saves the block on hover
 * and the terminal after the run, dark and light.
 */
import { expect, test, type Page } from "@playwright/test";
import { archiveThreads, cli, cliJson, liveProject, MODEL, openApp, requireLive, shot, threadInfo, waitThread, type LiveThread } from "./live";

requireLive();

const BLOCK = "```bash\necho run-$((6*7))\npwd\n```";

/** LIVE_THREAD, else a thread of the scratch project asked for the block (one short turn). */
let THREAD = process.env.LIVE_THREAD ?? "";
let started = "";
test.beforeAll(() => {
  test.setTimeout(180_000);
  if (THREAD) return;
  const prompt = `Reply with exactly this fenced code block and nothing else. Do not run it, use no tools.\n\n${BLOCK}`;
  started = (cliJson("thread", "new", "--worktree", liveProject().path, "--model", MODEL, "--effort", "medium", "--name", "live-codeblock", "--focus=false", "--prompt", prompt) as LiveThread).id;
  THREAD = started;
  waitThread(started);
});
test.afterAll(() => {
  if (started) archiveThreads(started);
});

/** The thread's running shells, from the daemon. */
function shellsOf(thread: string): string[] {
  const list = (JSON.parse(cli("terminal", "list", "--json")) as { terminals?: { id: string; state?: string; labels?: Record<string, string> }[] }).terminals ?? [];
  return list.filter((t) => t.labels?.kind === "shell" && t.labels.thread === thread && t.state !== "TERMINAL_STATE_EXITED").map((t) => t.id);
}

function screenText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __cfTerminal?: { renderer: { getText(): string } } }).__cfTerminal?.renderer.getText() ?? "");
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

async function shots(page: Page, name: string): Promise<void> {
  if (!process.env.LIVE_SHOTS) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: "dark" });
}

test("Run in terminal runs the block once in a new shell of the thread, which stays open", async ({ page }) => {
  expect(shellsOf(THREAD)).toEqual([]);
  await openApp(page);
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", THREAD);
  const block = page.locator('[data-testid="thread-text"]').last().locator(".cf-code").filter({ has: page.locator('pre[data-lang="bash"]') });
  await expect(block).toContainText("echo run-$((6*7))");
  await block.hover();
  const run = block.getByTestId("code-run");
  await expect(block.locator(".cf-code-actions")).toHaveCSS("opacity", "1");
  await expect(block.getByTestId("code-copy")).toBeVisible();
  await shots(page, "block");

  await run.click();
  const bottom = page.getByTestId("bottom-panel");
  const host = page.getByTestId("bottom-terminal-host");
  await expect(bottom.getByRole("tab")).toHaveCount(1);
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="bottom-terminal-host"]') !== null)).toBe(true);
  const id = await host.getAttribute("data-terminal-id");
  expect(shellsOf(THREAD)).toEqual([id]);
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain("run-42");
  // pwd: the shell runs in the thread's checkout.
  await expect.poll(() => screenText(page)).toContain(threadInfo(THREAD)?.worktreePath ?? "-");
  // Typed after the prompt: each line echoed once, not once more above the prompt.
  const text = await screenText(page);
  expect(count(text, "echo run-$((6*7))")).toBe(1);
  expect(count(text, "\npwd") + count(text, " pwd")).toBe(1);
  // The shell stays: still running a while later, still the panel's tab.
  await page.waitForTimeout(1500);
  expect(shellsOf(THREAD)).toEqual([id]);
  await expect(host).toHaveAttribute("data-terminal-id", id ?? "");
  await page.mouse.move(0, 0);
  await shots(page, "ran");
});
