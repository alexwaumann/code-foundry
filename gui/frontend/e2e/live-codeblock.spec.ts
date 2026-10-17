/**
 * Live e2e: a code block's "Run in terminal" against a REAL daemon
 * (docs/notes/code-block-actions.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon
 * (CODE_FOUNDRY_HOME) and the Vite dev server pointed at it, and name a thread
 * (LIVE_THREAD) whose last reply has a bash block running `echo run-$((6*7))` and `pwd`,
 * and that owns no shells yet.
 *
 * It hovers the block (Copy and Run show), clicks Run: one new shell in the thread's
 * bottom panel, with the keyboard, that ran both lines once (each echoed once, after the
 * prompt) and is still running afterwards. With LIVE_SHOTS it saves the block on hover
 * and the terminal after the run, dark and light.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const THREAD = process.env.LIVE_THREAD ?? "";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 60_000 });
}

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
  if (!SHOTS) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
}

test.skip(!LIVE || !HOME || !THREAD, "LIVE_DAEMON=1, CODE_FOUNDRY_HOME and LIVE_THREAD are required");

test("Run in terminal runs the block once in a new shell of the thread, which stays open", async ({ page }) => {
  expect(shellsOf(THREAD)).toEqual([]);
  await page.goto("/");
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", THREAD);
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
  await expect.poll(() => screenText(page)).toContain("/cf-cba-scratch");
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
