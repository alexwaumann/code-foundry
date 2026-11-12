/**
 * Live e2e: cmd+j starts a shell in a thread's empty bottom panel, and the last shell's
 * exit hides the panel (docs/notes/bottom-panel-autoshell.md), against a REAL daemon.
 * Opt-in; how to run it: docs/notes/live-e2e.md. The thread is LIVE_THREAD (one that owns
 * no shells yet), else an idle thread it starts in the scratch project and archives at the
 * end; no Claude turns.
 *
 * It presses cmd+j (a real terminal.new; the shell takes the keyboard), types into the
 * shell, types `exit` (the daemon reaps the shell; the panel hides), presses cmd+j again
 * (a fresh shell), and closes that one with cmd+w (the panel hides again). With
 * LIVE_SHOTS it saves the panel after cmd+j in dark and light. A second test leaves the
 * page with the panel open, closes the shell with the CLI meanwhile, and comes back: the
 * List on connect finds no shell, so the persisted open panel stays closed (what a daemon
 * restart, which prunes every shell, looks like to the GUI).
 */
import { expect, test, type Page } from "@playwright/test";
import { archiveThreads, cli, cliJson, liveProject, MODEL, openApp, requireLive, shot, type LiveThread } from "./live";

requireLive();

/** LIVE_THREAD, else an idle thread of the scratch project started for this file (no turn). */
let THREAD = process.env.LIVE_THREAD ?? "";
let started = "";
test.beforeAll(() => {
  if (THREAD) return;
  started = (cliJson("thread", "new", "--worktree", liveProject().path, "--model", MODEL, "--name", "live-bottom", "--focus=false") as LiveThread).id;
  THREAD = started;
});
test.afterAll(() => {
  if (started) archiveThreads(started);
});

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

test("cmd+j starts a real shell, exit hides the panel, cmd+j starts a fresh one", async ({ page }) => {
  expect(shellsOf(THREAD)).toEqual([]);
  await openApp(page);
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", THREAD);
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
  if (process.env.LIVE_SHOTS) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await shot(page, `thread-${scheme}`);
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
  await openApp(page);
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await page.keyboard.press("Meta+j");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  const id = (await host(page).getAttribute("data-terminal-id")) ?? "";
  await page.goto("about:blank");
  cli("terminal", "close", "--id", id);
  await expect.poll(() => shellsOf(THREAD)).toEqual([]);
  await openApp(page);
  await page.locator(`[data-row-key="s:${THREAD}"]`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", THREAD);
  await expect(page.getByTestId("thread-header").getByTestId("bottom-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(bottom(page)).toHaveCount(0);
});
