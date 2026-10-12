import { expect, test, type Locator, type Page } from "@playwright/test";
import { invocations, mockPost, mockUrl, openApp, openStreams, resetMock, row } from "./fixtures";

/**
 * The rendered thread (components/thread, docs/notes/rendered-threads-2-gui.md) over the
 * mock's scripted "Fix stale PR badge" (mock/thread.ts), in both schemes. Set SHOTS=<dir>
 * to save screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

type State = "permission" | "question" | "streaming" | "idle" | "closed" | "crashed";

async function openThread(page: Page, state: State, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

/**
 * The timeline is virtualized: only rows near the viewport exist. Scrolls it from the top
 * down until `target` is mounted, then into view.
 */
async function reveal(page: Page, target: Locator): Promise<Locator> {
  const timeline = page.getByTestId("thread-timeline");
  await timeline.evaluate((el) => {
    el.scrollTop = 0;
  });
  for (let i = 0; i < 60 && (await target.count()) === 0; i++) {
    await timeline.evaluate((el) => {
      el.scrollTop += el.clientHeight / 2;
    });
    await page.waitForTimeout(30);
  }
  await target.first().scrollIntoViewIfNeeded();
  return target.first();
}

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/thread/calls`);
  return (await res.json()) as string[];
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const pane = (page: Page) => page.getByTestId("thread-pane");
const footers = (page: Page) => page.getByTestId("thread-footer");

for (const scheme of ["dark", "light"] as const) {
  test.describe(scheme, () => {
    test("the timeline: user tags, folded earlier turn, work rows, diff, subagent, markdown", async ({ page }) => {
      await openThread(page, "permission", scheme);
      // The first message's tags, drawn from the composer text the item carries: a lone
      // "/tmp" in the prose stays text.
      const bubble = await reveal(page, page.getByTestId("thread-user"));
      await expect(bubble.locator('[data-tag-kind="image"]')).toContainText("pr-badge-stale.png");
      await expect(bubble.locator('[data-tag-kind="image"] img')).toBeVisible();
      await expect(bubble.locator('[data-tag-kind="file"]')).toHaveText("poller.go");
      await expect(bubble.locator('[data-tag-kind="skill"]')).toHaveText("/tdd");
      await expect(bubble).toContainText("with /tdd. Keep the fingerprint check-count based in /tmp.");

      // Turn 1 is finished and not the latest: folded to its answer and footer.
      const first = footers(page).first();
      await expect(first).toHaveAttribute("data-folded", "true");
      await expect(first).toContainText("Worked for 4m 08s");
      await expect(first).toContainText("12 steps");
      await expect(first).toContainText("$1.12");
      await expect(pane(page).getByTestId("thread-group")).toHaveCount(0);
      await expect(pane(page).locator('[data-testid="thread-text"][data-final]').first()).toContainText("Fixed: stale badge after a force-push");
      // The latest turn is open.
      await expect(footers(page)).toHaveCount(1);
      await expect(pane(page).locator('[data-tool="Bash"]').first()).toContainText("go test ./...");

      await first.locator("button.fold").click();
      await expect(first).not.toHaveAttribute("data-folded", "true");
      const groups = pane(page).getByTestId("thread-group");
      await reveal(page, groups);
      await expect(groups.first()).toContainText("Read 3 files, searched code 2 times");
      await expect(groups.nth(1)).toContainText("Read 2 files, searched code once");
      await expect(pane(page).getByTestId("thread-thinking").first()).toContainText("Thought for 9s");
      await expect(pane(page).getByTestId("thread-question-row")).toContainText("Head SHA in the fingerprint");
      await expect(pane(page).locator('[data-tool="Write"]')).toContainText("Created fingerprint_test.go");
      await expect(pane(page).locator('[data-tool="Bash"]').first()).toContainText("exit 1");

      // Expanding a group shows its members; a Grep shows its matches.
      await groups.nth(1).click();
      await pane(page).locator('[data-tool="Grep"]').getByTestId("thread-tool").click();
      await expect(pane(page).getByTestId("thread-matches")).toContainText("internal/store/pr/model.go");
      await expect(pane(page).getByTestId("thread-matches").locator("mark").first()).toHaveText(/HeadRefOid/i);

      // The failing test run: command, output, failure lines.
      await pane(page).locator('[data-tool="Bash"]').first().getByTestId("thread-tool").click();
      await expect(pane(page).getByTestId("thread-bash").first()).toContainText("--- FAIL: TestFingerprintChangesOnForcePush");

      // The Edit: an inline unified diff from the result's structuredPatch.
      const edit = await reveal(page, pane(page).locator('[data-tool="Edit"]'));
      await expect(edit).toContainText("+6");
      await edit.getByTestId("thread-tool").click();
      const diff = edit.getByTestId("thread-diff");
      await expect(diff).toContainText("@@ -18,9 +18,14 @@");
      await expect(diff.locator('[data-kind="add"]')).toHaveCount(6);
      await expect(diff.locator('[data-kind="del"]')).toHaveCount(1);
      await expect(diff.locator(".hljs-keyword").first()).toBeVisible();

      // The subagent: nested rows and its report.
      const agent = await reveal(page, pane(page).locator('[data-tool="Agent"]'));
      await expect(agent).toContainText("Review the fingerprint change");
      await expect(agent).toContainText("4 tools · 41s");
      await agent.getByTestId("thread-tool").first().click();
      await expect(agent.locator(".children")).toContainText("Read 2 files, searched code once");
      await expect(agent.locator(".children")).toContainText("go vet ./internal/store/pr/...");
      await expect(agent.locator(".subresult")).toContainText("Looks right.");

      // The final answer's markdown: GFM table, highlighted Go in the bundled mono.
      const answer = await reveal(page, pane(page).locator('[data-testid="thread-text"][data-final]'));
      await expect(answer.locator("table tr")).toHaveCount(4);
      await expect(answer.locator('pre[data-lang="go"] .hljs-keyword').first()).toHaveText("func");
      expect(await answer.locator("pre code").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("JetBrainsMono Nerd Font Mono");
      await shot(page, `thread-timeline-${scheme}`);

      // The footer folds it again.
      await reveal(page, first);
      await first.locator("button.fold").click();
      await expect(first).toHaveAttribute("data-folded", "true");
      await expect(pane(page).locator('[data-tool="Edit"]')).toHaveCount(0);
    });

    test("a pending permission docks into the composer; the timeline keeps an amber row", async ({ page }) => {
      await openThread(page, "permission", scheme);
      await expect(row(page, "s:s-r1")).toContainText("Needs input · Bash git push");
      const waiting = pane(page).locator('[data-waiting="true"]');
      await expect(waiting).toContainText("Run git push --force-with-lease origin cf/pr-badge-stale");
      await expect(waiting.getByTestId("thread-waiting")).toHaveText("waiting for you");
      const color = await waiting.getByTestId("thread-waiting").evaluate((el) => getComputedStyle(el).color);
      expect(color).not.toBe(await waiting.locator(".lbl").evaluate((el) => getComputedStyle(el).color));

      const composer = page.getByTestId("thread-composer");
      const prompt = composer.getByTestId("thread-permission");
      await expect(prompt).toContainText("Allow Claude to run this command?");
      await expect(prompt).toContainText("git push --force-with-lease origin cf/pr-badge-stale");
      await expect(prompt).toContainText("Allow for session adds Bash(git push:*)");
      await expect(prompt.getByTestId("thread-permission-allow")).toBeVisible();
      await expect(prompt.getByTestId("thread-permission-allow-session")).toBeVisible();
      await expect(prompt.getByTestId("thread-permission-deny")).toBeVisible();
      // One Interrupt: the composer's.
      await expect(page.getByText("Interrupt", { exact: true })).toHaveCount(1);
      await expect(composer.getByTestId("thread-interrupt")).toBeVisible();
      // The prompt sits above the editor, inside the card.
      const promptBox = await prompt.boundingBox();
      const editorBox = await composer.getByTestId("composer-prompt").boundingBox();
      expect(promptBox && editorBox && promptBox.y + promptBox.height <= editorBox.y + 1).toBe(true);
      await shot(page, `thread-permission-${scheme}`);

      // Answering: e2e/thread-prompts.spec.ts.
    });

    test("streaming: a caret while the answer grows, then the footer when the turn ends", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const streaming = pane(page).locator('[data-testid="thread-text"][data-streaming]');
      await expect(streaming).toContainText("ReviewState: pr.Revi");
      const caret = await streaming.locator(".cf-streaming pre code").evaluate((el) => getComputedStyle(el, "::after").content);
      expect(caret).toBe('""');
      await expect(page.getByTestId("thread-working")).toContainText("Working");
      await expect(footers(page)).toHaveCount(0);
      await shot(page, `thread-streaming-${scheme}`);

      await mockPost("thread/delta?text=" + encodeURIComponent("ewDecision,\n"));
      await expect(streaming).toContainText("ReviewState: pr.ReviewDecision,");
      // The view follows the bottom while it streams.
      await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");

      await mockPost("thread/finish");
      await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
      await expect(page.getByTestId("thread-working")).toHaveCount(0);
      await expect(footers(page)).toHaveCount(1);
      await expect(pane(page).locator('[data-testid="thread-text"][data-final]').last()).toContainText("I have not pushed.");
    });

    test("the latest finished turn keeps its footer in view; only the user's scroll unpins the list", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const timeline = page.getByTestId("thread-timeline");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      // A scroll nobody asked for (the virtualizer keeping rows in place while it measures
      // the ones above) leaves the list pinned.
      await timeline.evaluate((el) => {
        el.scrollTop -= 160;
      });
      await mockPost("thread/finish");
      const footer = footers(page).last();
      // The turn's own cost and the model that replied, from the daemon's turn_end.
      await expect(footer).toContainText(/Worked for .*·12 steps·\$0\.04·Opus 4\.8/);
      await expect(footer).not.toHaveAttribute("data-folded", "true");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      await expect
        .poll(async () => {
          const box = await footer.boundingBox();
          const composer = await page.getByTestId("thread-composer").boundingBox();
          return box && composer && box.y + box.height <= composer.y;
        })
        .toBe(true);

      // The user's wheel unpins: new content no longer moves the list.
      const box2 = await timeline.boundingBox();
      await page.mouse.move((box2?.x ?? 0) + 200, (box2?.y ?? 0) + 200);
      await page.mouse.wheel(0, -400);
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      const top = await timeline.evaluate((el) => el.scrollTop);
      await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
      await page.keyboard.type("more");
      await page.keyboard.press("Enter");
      await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
      expect(await timeline.evaluate((el) => el.scrollTop)).toBe(top);
    });
  });
}

test("footers: the daemon's turn cost and model win; turns without them fall back", async ({ page }) => {
  await openThread(page, "idle");
  // Turn 2 ran in a new process whose total passed the old one's: the difference of the
  // totals would say $0.38; the daemon's turn cost says $1.50, and Sonnet 5 answered.
  await expect(footers(page).last()).toContainText(/·\$1\.50·Sonnet 5$/);
  // Turn 1 predates the fields: its cost is the running total (the first turn) and the
  // model the thread's.
  await expect(await reveal(page, footers(page))).toContainText(/\$1\.12·Opus$/);
});

test("a pending question docks with its pager", async ({ page }) => {
  await openThread(page, "question");
  await expect(row(page, "s:s-r1")).toContainText("Asked a question");
  await expect(pane(page).getByTestId("thread-question-row")).toContainText("Asking 2 questions");
  const q = page.getByTestId("thread-composer").getByTestId("thread-question");
  await expect(q).toContainText("Claude has 2 questions");
  await expect(q).toContainText("1 of 2");
  // Three options and Other.
  await expect(q.getByRole("radio")).toHaveCount(4);
  await q.getByRole("radio").nth(1).click();
  await expect(q.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
  await q.getByTestId("thread-question-next").click();
  await expect(q).toContainText("2 of 2");
  await expect(q).toContainText("Should I also update the PR description?");
});

test("a follow-up goes through thread.send with the composer's tags projected; the reply streams in", async ({ page }) => {
  await openThread(page, "idle");
  const editor = page.getByTestId("thread-composer").locator('[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type("Ship it with /revi");
  await expect(page.getByTestId("completion-card")).toBeVisible();
  // The card opens above the composer (it sits at the pane's bottom).
  const card = await page.getByTestId("completion-card").boundingBox();
  const composer = await page.getByTestId("thread-composer").boundingBox();
  expect(card && composer && card.y + card.height <= composer.y + 1).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-composer").getByTestId("prompt-tag")).toHaveText("/review");
  await page.keyboard.press("Enter");
  await expect.poll(calls).toContain("send s-r1 Ship it with /review");
  const send = (await invocations()).find((i) => i.name === "thread.send");
  expect(send?.args).toMatchObject({ id: "s-r1", text: "Ship it with /review" });
  expect(send?.args["composer-text"]).toMatch(/^Ship it with \[\/review\]\(cf-skill:\/\/[\w.~-]+\/review\)$/);
  expect(send?.context?.activeSessionRendered).toBe(true);
  await expect(page.getByTestId("thread-user").last()).toContainText("Ship it with");
  await expect(page.getByTestId("thread-user").last().locator('[data-tag-kind="skill"]')).toHaveText("/review");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
  await expect(footers(page)).toHaveCount(3);
  // The draft cleared; earlier turns folded, the latest open.
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "");
  await expect(footers(page).nth(0)).toHaveAttribute("data-folded", "true");
  await expect(footers(page).nth(1)).toHaveAttribute("data-folded", "true");
  await expect(footers(page).nth(2)).not.toHaveAttribute("data-folded", "true");
});

test("Interrupt stops the running turn (thread.interrupt)", async ({ page }) => {
  await openThread(page, "streaming");
  await page.getByTestId("thread-interrupt").click();
  await expect.poll(calls).toContain("interrupt s-r1");
  await expect(footers(page).last()).toContainText("Interrupted");
  await expect(page.getByTestId("thread-interrupt")).toHaveCount(0);
});

test("only the visible rendered thread holds a Watch; it takes the content pane's Attach slot", async ({ page }) => {
  await openThread(page, "idle");
  await expect.poll(async () => (await openStreams())["ThreadService/Watch"] ?? 0).toBe(1);
  expect((await openStreams())["TerminalService/Attach"] ?? 0).toBe(0);
  await row(page, "s:s-2").click();
  await expect.poll(async () => (await openStreams())["ThreadService/Watch"] ?? 0).toBe(0);
  await expect.poll(async () => (await openStreams())["TerminalService/Attach"] ?? 0).toBe(1);
  await row(page, "s:s-r1").click();
  await expect.poll(async () => (await openStreams())["ThreadService/Watch"] ?? 0).toBe(1);
});

test("the thread.* commands are offered for a rendered thread", async ({ page }) => {
  await openThread(page, "idle");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Interrupt Thread");
  await expect(page.getByRole("option", { name: /Interrupt Thread/ })).toBeVisible();
});

test("a claude that died before the handshake: its error in the timeline, Reconnect, then Starting Claude…", async ({ page }) => {
  await openThread(page, "crashed");
  await expect(pane(page).getByTestId("thread-error")).toHaveText("Claude exited (code 1) before answering the initialize handshake: error: unknown option '--bogus'");
  const bar = page.getByTestId("thread-disconnected");
  await expect(bar).toContainText("Not connected · crashed (exit code 1)");
  await expect(page.getByTestId("thread-composer")).toHaveCount(0);
  await shot(page, "crashed");
  await bar.getByRole("button", { name: "Reconnect" }).click();
  // Until Claude answers the handshake the timeline says so (no elapsed time: no turn yet).
  const starting = page.getByTestId("thread-working");
  await expect(starting).toHaveText("Starting Claude…");
  await expect(starting).toHaveAttribute("data-starting", "true");
  await shot(page, "starting");
  await expect(page.getByTestId("thread-composer")).toBeVisible();
  await expect(starting).toHaveCount(0, { timeout: 5000 });
  await expect(pane(page).getByTestId("thread-error")).toBeVisible();
});

test("a closed thread keeps its conversation above the Reconnect bar", async ({ page }) => {
  await openThread(page, "closed");
  await expect(page.getByTestId("thread-disconnected")).toContainText("Not connected · closed. Reconnect to continue the conversation.");
  await expect(footers(page).last()).toContainText("Sonnet 5");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("All 412 tests pass and the branch is pushed");
  await expect(page.getByTestId("thread-working")).toHaveCount(0);
  await expect(page.getByTestId("thread-empty")).toHaveCount(0);
});

test("a fork of a rendered thread is rendered and starts empty, naming its parent", async ({ page }) => {
  await openThread(page, "idle");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Fork Thread");
  await page.keyboard.press("Enter");
  const fork = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(fork).not.toHaveAttribute("data-row-key", "s:s-r1");
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("session-render")).toHaveText("rendered");
  await expect(page.getByTestId("thread-working")).toHaveText("Starting Claude…");
  await expect(page.getByTestId("thread-empty")).toHaveText("Forked from Fix stale PR badge. Claude has the conversation so far; send a follow-up to continue.", { timeout: 5000 });
  await shot(page, "fork-empty");
});

test("the follow-up placeholder says a message while Claude works is picked up mid-turn; one Interrupt", async ({ page }) => {
  await openThread(page, "streaming");
  const editor = page.getByTestId("thread-composer").locator('[contenteditable="true"]');
  await expect(editor).toHaveAttribute("aria-placeholder", "Send a follow-up… Claude picks it up mid-turn");
  await expect(pane(page).getByRole("button", { name: /Interrupt/ })).toHaveCount(1);
  await mockPost("thread/finish");
  await expect(editor).toHaveAttribute("aria-placeholder", "Send a follow-up…");
  await expect(pane(page).getByRole("button", { name: /Interrupt/ })).toHaveCount(0);
});
