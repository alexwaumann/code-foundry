/**
 * Live e2e: cmd+j starts a shell in a thread's empty bottom panel, and the last shell's
 * exit hides the panel (docs/notes/bottom-panel-autoshell.md), against a REAL daemon.
 * Opt-in (LIVE_DAEMON=1), run with playwright.live.config.ts, which starts nothing: bring
 * up an isolated daemon (CODE_FOUNDRY_HOME) and the Vite dev server pointed at it (recipe
 * in docs/notes/phase2-integration.md), and name a thread of that daemon (LIVE_THREAD)
 * that owns no shells yet.
 *
 * It presses cmd+j (a real terminal.new; the shell takes the keyboard), types into the
 * shell, types `exit` (the daemon reaps the shell; the panel hides), presses cmd+j again
 * (a fresh shell), and closes that one with cmd+w (the panel hides again). With
 * LIVE_SHOTS it saves the panel after cmd+j in dark and light. A second test leaves the
 * page with the panel open, closes the shell with the CLI meanwhile, and comes back: the
 * List on connect finds no shell, so the persisted open panel stays closed (what a daemon
 * restart, which prunes every shell, looks like to the GUI).
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

/** The thread's shells, from the daemon. */
function shellsOf(thread: string): string[] {
  const list = (JSON.parse(cli("terminal", "list", "--json")) as { terminals?: { id: string; labels?: Record<string, string> }[] }).terminals ?? [];
  return list.filter((t) => t.labels?.kind === "shell" && t.labels.thread === thread).map((t) => t.id);
}

const bottom = (page: Page) => page.getByTestId("bottom-panel");
const host = (page: Page) => page.getByTestId("bottom-terminal-host");

function region(page: Page) {
  return page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") ?? null);
}

function focusInBottomTerminal(page: Page) {
  return page.evaluate(() => document.activeElement?.closest('[data-testid="bottom-terminal-host"]') !== null);
}

test.skip(!LIVE || !HOME || !THREAD, "LIVE_DAEMON=1, CODE_FOUNDRY_HOME and LIVE_THREAD are required");

test("cmd+j starts a real shell, exit hides the panel, cmd+j starts a fresh one", async ({ page }) => {
  expect(shellsOf(THREAD)).toEqual([]);
  await page.goto("/");
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", THREAD);
  await expect(bottom(page)).toHaveCount(0);

  await page.keyboard.press("Meta+j");
  await expect(bottom(page).getByRole("tab")).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(bottom(page).getByTestId("bottom-empty")).toHaveCount(0);
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);
  const first = await host(page).getAttribute("data-terminal-id");
  expect(shellsOf(THREAD)).toEqual([first]);

  // The keyboard is in the real shell.
  await page.keyboard.type("echo autoshell-$((6*7))");
  await page.keyboard.press("Enter");
  // Renderer-agnostic (WebGL has no DOM text): the bottom host is window.__cfTerminal.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cfTerminal?: { renderer: { getText(): string } } }).__cfTerminal?.renderer.getText() ?? ""))
    .toContain("autoshell-42");
  if (SHOTS) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `thread-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await host(page).click();
  }

  // `exit`: the daemon reaps the shell, the tab goes, and the panel with it.
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => region(page)).toBe("content");
  await expect.poll(() => shellsOf(THREAD)).toEqual([]);

  // cmd+j again: a fresh shell.
  await page.keyboard.press("Meta+j");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  const second = await host(page).getAttribute("data-terminal-id");
  expect(second).not.toBe(first);
  await expect.poll(() => focusInBottomTerminal(page)).toBe(true);

  // cmd+w closes it (terminal.close), the last one: the panel hides again.
  await page.keyboard.press("Meta+w");
  await expect(bottom(page)).toHaveCount(0);
  await expect.poll(() => shellsOf(THREAD)).toEqual([]);
});

test("a panel whose shells went while the page was away comes back closed", async ({ page }) => {
  expect(shellsOf(THREAD)).toEqual([]);
  await page.goto("/");
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await page.keyboard.press("Meta+j");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  const id = (await host(page).getAttribute("data-terminal-id")) ?? "";
  await page.goto("about:blank");
  cli("terminal", "close", "--id", id);
  await expect.poll(() => shellsOf(THREAD)).toEqual([]);
  await page.goto("/");
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", THREAD);
  await expect(page.getByTestId("thread-header").getByTestId("bottom-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(bottom(page)).toHaveCount(0);
});
