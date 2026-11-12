/**
 * Live e2e: threads end to end, the GUI against a real daemon running real Claude Code.
 * Opt-in; how to run it: docs/notes/live-e2e.md (helpers in e2e/live.ts).
 *
 * It starts two threads in the scratch project (LIVE_PROJECT, else the first registered)
 * and spends three short turns ("pong", "ping", "ping") on LIVE_MODEL (default Haiku 5.5),
 * writes their transcripts under ~/.claude/projects/, and archives its threads at the end.
 */
import { expect, test, type Page } from "@playwright/test";
import { row, threadPrompt } from "./fixtures";
import { archiveThreads, cli, cliJson, listThreads, liveProject, MODEL, openApp, requireLive, shot, threadInfo, type LiveThread } from "./live";

function badge(page: Page, id: string) {
  return row(page, `s:${id}`).locator("[data-thread-badge]");
}

/** Records every distinct badge value of a thread row, sampled every 50 ms in the page. */
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
        document.querySelector(sel)?.getAttribute("data-thread-badge") ?? "";
      if (v && w.__badgeLog.at(-1) !== v) w.__badgeLog.push(v);
    }, 50);
  }, `[data-row-key="s:${id}"] [data-thread-badge]`);
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

requireLive();

test("threads end to end against the real daemon", async ({ page }) => {
  const project = liveProject();
  const worktree = process.env.LIVE_WORKTREE ?? project.path;
  const created: string[] = [];
  try {
    // (a) A thread created from the CLI shows up in the sidebar, idle.
    const s1 = cliJson("thread", "new", "--worktree", worktree, "--model", MODEL, "--effort", "medium") as LiveThread;
    created.push(s1.id);
    await test.step("a: CLI-created thread is listed idle", async () => {
      await openApp(page);
      await expect(row(page, `s:${s1.id}`)).toBeVisible();
      await expect(badge(page, s1.id)).toHaveAttribute(
        "data-thread-badge",
        "idle",
        { timeout: 30_000 },
      );
    });

    // (b) Selecting it shows the (empty) conversation with the prompt focused.
    await test.step("b: selecting shows the thread, its prompt focused", async () => {
      await row(page, `s:${s1.id}`).click();
      await expect(pane(page)).toHaveAttribute("data-thread-id", s1.id);
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
        "data-thread-badge",
        "busy",
        { timeout: 20_000 },
      );
      await expect(badge(page, s1.id)).toHaveAttribute(
        "data-thread-badge",
        "idle",
        { timeout: 90_000 },
      );
      await expect(pane(page).getByTestId("thread-text").last()).toContainText(
        /pong/i,
      );
      await expect(
        pane(page).locator('[data-testid="thread-turn-header"]:not([data-live])').last(),
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
    // "finished" in the CLI; showing the thread in the GUI clears it to idle.
    await test.step("c': an unwatched turn needs attention until viewed", async () => {
      await page.goto("about:blank"); // no GUI attached (thread.new would focus it)
      const s2 = cliJson("thread", "new", "--worktree", worktree, "--model", MODEL, "--effort", "medium", "--name", "unwatched", "--prompt", "reply with the single word ping") as LiveThread;
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
      expect(cli("thread", "list")).toMatch(/attention \(finished\)\s+unwatched/);
      await openApp(page);
      await expect(badge(page, s2.id)).toHaveAttribute(
        "data-thread-badge",
        "attention",
      );
      await expect(page).toHaveTitle("Code Foundry (1)");
      await row(page, `s:${s2.id}`).click();
      await expect(pane(page).getByTestId("thread-user").first()).toContainText(
        "reply with the single word ping",
      );
      await expect(badge(page, s2.id)).toHaveAttribute(
        "data-thread-badge",
        "idle",
      );
      await expect
        .poll(() => threadInfo(s2.id)?.status)
        .toBe("THREAD_STATUS_IDLE");
      await expect(page).toHaveTitle("Code Foundry");
    });

    // (d) Archiving from the CLI stops Claude and lists the thread apart (the GUI's selection
    // leaves it). Opened from the Archived section, the pane looks the same (the composer, no
    // reconnect card), and a message starts Claude again with the conversation kept.
    await test.step("d: an archived thread keeps its composer; a message continues it", async () => {
      cli("thread", "archive", "--id", s1.id, "--archived", "--yes");
      await expect
        .poll(() => threadInfo(s1.id)?.state, { timeout: 20_000 })
        .toBe("THREAD_STATE_DISCONNECTED");
      await page.getByTestId("thread-list").getByRole("button", { name: /^Archived/ }).click();
      await row(page, `s:${s1.id}`).click();
      await expect(pane(page)).toHaveAttribute("data-thread-id", s1.id);
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
        "data-thread-badge",
        /^(idle|attention)$/,
        { timeout: 30_000 },
      );
    });

    // (e) cmd+n (from the focused prompt) opens the project picker, then the new-thread
    // composer for the picked project, which offers the model families; Escape leaves
    // without creating anything.
    await test.step("e: cmd+n opens the picker, then the composer", async () => {
      const before = listThreads().length;
      await threadPrompt(page).click();
      await page.keyboard.press("Meta+n");
      const palette = page.getByTestId("palette");
      await expect(palette).toHaveAttribute("data-mode", "projects");
      await page.waitForTimeout(400); // let the palette's open animation finish
      await shot(page, "new-thread-picker.png");
      // The top row is No project; the project rows follow the workspaces.
      await palette.locator(`[data-project="${project.id}"]`).click();
      await expect(palette).toHaveCount(0);
      await expect(page.getByTestId("composer-heading")).toHaveText(
        `What should we build in ${project.name}?`,
      );
      await expect(page.getByTestId("composer-input")).toBeFocused();
      await page.getByTestId("composer-model").click();
      const models = page
        .getByTestId("composer-model-list")
        .getByRole("option");
      for (const m of ["Opus", "Sonnet", "Haiku"])
        await expect(models.filter({ hasText: m }).first()).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      expect(listThreads()).toHaveLength(before); // nothing was created
    });

    // (f) `thread focus` from the CLI selects the thread in the GUI.
    await test.step("f: CLI focus selects the thread", async () => {
      await row(page, `s:${created[1] ?? ""}`).click();
      await expect(row(page, `s:${created[1] ?? ""}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(cli("thread", "focus", "--id", s1.id)).toMatch(/windows=[1-9]/);
      await expect(row(page, `s:${s1.id}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(pane(page)).toHaveAttribute("data-thread-id", s1.id);
    });
  } finally {
    archiveThreads(...created);
    // For the caller's cleanup of ~/.claude/projects/<slug>/<id>.jsonl.
    console.log("live threads:", created.join(" "));
  }
});
