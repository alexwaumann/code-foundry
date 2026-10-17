import { expect, test, type Locator, type Page } from "@playwright/test";
import { invocations, mockPost, mockUrl, openApp, openStreams, resetMock, row, testPdf } from "./fixtures";

/**
 * A thread (components/thread, docs/notes/rendered-threads-2-gui.md) over the
 * mock's scripted "Fix stale PR badge" (mock/thread.ts), in both schemes. Set SHOTS=<dir>
 * to save screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

type State = "permission" | "question" | "streaming" | "idle" | "stopped" | "crashed";

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

/**
 * Scrolls the timeline up with the wheel (the user's scroll, so the list unpins rather
 * than following the bottom back) until `target` is inside it.
 */
async function wheelUpTo(page: Page, target: Locator): Promise<void> {
  const box = await page.getByTestId("thread-timeline").boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + 200, box.y + 200);
  for (let i = 0; i < 40; i++) {
    const t = (await target.count()) > 0 ? await target.boundingBox() : null;
    if (t && t.y >= box.y && t.y + t.height <= box.y + box.height) return;
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(50);
  }
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
/** Finished turns' headers (the running turn's live header is "thread-working" inside it). */
const headers = (page: Page) => page.locator('[data-testid="thread-turn-header"]:not([data-live])');

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

      // Turn 1 is finished and not the latest: folded to its message, header and answer.
      const first = headers(page).first();
      await expect(first).toHaveAttribute("data-folded", "true");
      await expect(first).toContainText("Worked for 4m 08s");
      await expect(first).toContainText("12 steps");
      await expect(pane(page).getByTestId("thread-group")).toHaveCount(0);
      await expect(pane(page).locator('[data-testid="thread-text"][data-final]').first()).toContainText("Fixed: stale badge after a force-push");
      // The latest turn is open.
      await expect(headers(page)).toHaveCount(1);
      await expect(pane(page).locator('[data-tool="Bash"]').first()).toContainText("go test ./...");

      // Above the viewport (the list sits at the bottom): the user scrolls up to it.
      await wheelUpTo(page, first);
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
      // Framed (rounded, header filled) and as wide as the answer.
      const frame = answer.locator(".cf-table");
      expect(await frame.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("8px");
      expect(await frame.locator("th").first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await frame.locator("table").evaluate((el) => Math.abs(el.getBoundingClientRect().width - (el.closest(".cf-markdown")?.getBoundingClientRect().width ?? 0)))).toBeLessThan(3);
      await expect(answer.locator('pre[data-lang="go"] .hljs-keyword').first()).toHaveText("func");
      expect(await answer.locator("pre code").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("JetBrainsMono Nerd Font Mono");
      await shot(page, `thread-timeline-${scheme}`);

      // The header folds it again.
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

    test("streaming: a caret while the answer grows under the live header, which becomes the finished one in place", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const streaming = pane(page).locator('[data-testid="thread-text"][data-streaming]');
      await expect(streaming).toContainText("ReviewState: pr.Revi");
      const caret = await streaming.locator(".cf-streaming pre code").evaluate((el) => getComputedStyle(el, "::after").content);
      expect(caret).toBe('""');
      const live = pane(page).locator('[data-testid="thread-turn-header"][data-live]');
      await expect(live.getByTestId("thread-working")).toHaveText(/^Working·\d+ steps·\d/);
      await expect(headers(page)).toHaveCount(0);
      // Live, the header heads the turn's work: under its message, above the rows.
      const liveRow = live.locator("xpath=ancestor::*[@data-index][1]");
      await expect(liveRow.locator("xpath=preceding-sibling::*[1]")).toHaveAttribute("data-row-type", "user");
      await shot(page, `thread-streaming-${scheme}`);

      await mockPost("thread/delta?text=" + encodeURIComponent("ewDecision,\n"));
      await expect(streaming).toContainText("ReviewState: pr.ReviewDecision,");
      // The view follows the bottom while it streams.
      await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");

      const element = await live.elementHandle();
      await mockPost("thread/finish");
      await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
      await expect(page.getByTestId("thread-working")).toHaveCount(0);
      await expect(headers(page)).toHaveCount(1);
      await expect(headers(page)).toHaveAttribute("data-folded", "true");
      // The same element: the line changed in place, nothing remounted.
      expect(await element.evaluate((el) => el.isConnected && el.getAttribute("data-folded"))).toBe("true");
      const answer = pane(page).locator('[data-testid="thread-text"][data-final]').last();
      await expect(answer).toContainText("I have not pushed.");
      // The answer copies from a button shown while it is hovered; the header has none.
      await expect(headers(page).getByRole("button", { name: "Copy answer" })).toHaveCount(0);
      const copy = answer.getByRole("button", { name: "Copy answer" });
      await expect(copy).toHaveCSS("opacity", "0");
      await answer.hover();
      await expect(copy).toHaveCSS("opacity", "1");
    });

    test("the latest turn folds when it ends and keeps its header and answer in view; only the user's scroll unpins the list", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const timeline = page.getByTestId("thread-timeline");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      // A scroll nobody asked for (the virtualizer keeping rows in place while it measures
      // the ones above) leaves the list pinned.
      await timeline.evaluate((el) => {
        el.scrollTop -= 160;
      });
      await mockPost("thread/finish");
      const header = headers(page).last();
      // The turn's own cost and the model that replied, from the daemon's turn_end.
      await expect(header).toContainText(/Worked for .*·12 steps·\$0\.04·Opus 4\.8/);
      // Folded the moment it ended, the latest turn too: its work rows are gone.
      await expect(header).toHaveAttribute("data-folded", "true");
      await expect(pane(page).locator('[data-tool="Edit"]')).toHaveCount(0);
      const answer = pane(page).locator('[data-testid="thread-text"][data-final]').last();
      await expect(answer).toContainText("I have not pushed.");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      // Both on screen: the header below the timeline's top, the answer above the composer.
      await expect
        .poll(async () => {
          const h = await header.boundingBox();
          const a = await answer.boundingBox();
          const t = await timeline.boundingBox();
          const composer = await page.getByTestId("thread-composer").boundingBox();
          return !!h && !!a && !!t && !!composer && h.y >= t.y && h.y < a.y && a.y + a.height <= composer.y;
        })
        .toBe(true);
      if (process.env.SHOTS) {
        // Tall enough for the whole folded turn: the user's bubble, the header, the answer.
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        await shot(page, `thread-folded-${scheme}`);
      }
    });

    test("scrolled up, new content does not move the list and the fold on end keeps the user's place", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const timeline = page.getByTestId("thread-timeline");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      // The user's wheel unpins: the streamed text no longer moves the list.
      const box = await timeline.boundingBox();
      await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
      await page.mouse.wheel(0, -400);
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      const top = await timeline.evaluate((el) => el.scrollTop);
      await mockPost("thread/delta?text=" + encodeURIComponent("ewDecision,\n"));
      await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toContainText("ReviewState: pr.ReviewDecision,");
      expect(await timeline.evaluate((el) => el.scrollTop)).toBe(top);

      // The turn ends and folds under the user's eyes: the turn's message they scrolled
      // to stays where it was instead of the list jumping.
      const bubble = page.getByTestId("thread-user").last();
      const before = await bubble.boundingBox();
      await mockPost("thread/finish");
      await expect(headers(page).last()).toHaveAttribute("data-folded", "true");
      await expect.poll(async () => Math.round((await bubble.boundingBox())?.y ?? -1)).toBe(Math.round(before?.y ?? 0));
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
    });

    test("reading the answer when the turn ends: the work above it folds away and the answer stays put", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const timeline = page.getByTestId("thread-timeline");
      // A long answer, so the user reads it scrolled into its middle.
      const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i)}`).join("\n\n");
      await mockPost("thread/delta?text=" + encodeURIComponent(`ewDecision,\n}\n\`\`\`\n\n${lines}\n`));
      const answer = pane(page).locator('[data-testid="thread-text"][data-streaming]');
      await expect(answer).toContainText("line 59");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      const box = await timeline.boundingBox();
      await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
      await page.mouse.wheel(0, -300);
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      const before = await answer.boundingBox();
      // The answer starts above the viewport: the work rows above it are off screen.
      expect((before?.y ?? 0) < (box?.y ?? 0)).toBe(true);
      const text = pane(page).locator('[data-testid="thread-text"][data-final]').last();
      await mockPost("thread/finish");
      await expect(headers(page).last()).toHaveAttribute("data-folded", "true");
      await expect(pane(page).locator('[data-tool="Edit"]')).toHaveCount(0);
      await expect.poll(async () => Math.round((await text.boundingBox())?.y ?? -1)).toBe(Math.round(before?.y ?? 0));
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
    });

    test("scrolled into the turn's work when it ends: the header that replaces it is past the new bottom, so the list pins", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const timeline = page.getByTestId("thread-timeline");
      const box = await timeline.boundingBox();
      await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
      await page.mouse.wheel(0, -200);
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      await mockPost("thread/finish");
      const header = headers(page).last();
      await expect(header).toHaveAttribute("data-folded", "true");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      await expect
        .poll(async () => {
          const h = await header.boundingBox();
          const t = await timeline.boundingBox();
          const composer = await page.getByTestId("thread-composer").boundingBox();
          return !!h && !!t && !!composer && h.y >= t.y && h.y + h.height <= composer.y;
        })
        .toBe(true);
    });
  });
}

test("reading deep into an open tool row when the turn ends: the work folds up under the header, which takes the top", async ({ page }) => {
  await openThread(page, "streaming");
  const timeline = page.getByTestId("thread-timeline");
  // A long answer below the work, so there is room to keep the place.
  const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i)}`).join("\n\n");
  await mockPost("thread/delta?text=" + encodeURIComponent(`ewDecision,\n}\n\`\`\`\n\n${lines}\n`));
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toContainText("line 59");
  // The Edit row open (its diff is a few hundred px tall). Pinned, the list stays at the
  // bottom, so the row is clicked where it is (above the viewport).
  const edit = pane(page).locator('[data-tool="Edit"]').last();
  await edit.getByTestId("thread-tool").evaluate((b) => {
    (b as HTMLElement).click();
  });
  await expect(edit.getByTestId("thread-tool")).toHaveAttribute("aria-expanded", "true");
  const row = edit.locator("xpath=ancestor::*[@data-index][1]");
  const rowBox = await row.boundingBox();
  expect(rowBox?.height ?? 0).toBeGreaterThan(200);
  // The user's wheel unpins; then the viewport's top goes 150px into the open row.
  const box = await timeline.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  await page.mouse.wheel(0, -200);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  await row.evaluate((r) => {
    const el = r.closest('[data-testid="thread-timeline"]') as HTMLElement;
    el.scrollTop += r.getBoundingClientRect().top - el.getBoundingClientRect().top + 150;
  });
  await page.waitForTimeout(100);
  await mockPost("thread/finish");
  await expect(headers(page).last()).toHaveAttribute("data-folded", "true");
  await expect(pane(page).locator('[data-tool="Edit"]')).toHaveCount(0);
  const header = headers(page).last().locator("xpath=ancestor::*[@data-index][1]");
  await expect.poll(async () => Math.round(((await header.boundingBox())?.y ?? -1) - (box?.y ?? 0))).toBe(0);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
});

test("a click on a header folds or unfolds its turn without moving the header on screen", async ({ page }) => {
  // Tall enough for the whole folded thread: the list sits at the bottom (pinned) with the
  // first turn's header (12 steps) on screen.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await openThread(page, "idle");
  const timeline = page.getByTestId("thread-timeline");
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  const header = headers(page).first();
  await expect(header).toHaveAttribute("data-folded", "true");
  await expect(header).toContainText("12 steps");
  await page.waitForTimeout(200);
  const y = async () => Math.round((await header.boundingBox())?.y ?? -1);
  const before = await y();
  // Unfolded while pinned: the work opens below the header, which stays put rather than the
  // list following the bottom, so the list is no longer at the bottom.
  await header.locator("button.fold").click();
  await expect(header).not.toHaveAttribute("data-folded", "true");
  await expect(header.locator("button.fold")).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(200);
  expect(await y()).toBe(before);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  // Folded again: the work closes under it, still in place, and the list is at the bottom again.
  await header.locator("button.fold").click();
  await expect(header).toHaveAttribute("data-folded", "true");
  await page.waitForTimeout(200);
  expect(await y()).toBe(before);
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
});

test("headers: the daemon's turn cost and model; a turn without them shows neither", async ({ page }) => {
  await openThread(page, "idle");
  // Turn 2 ran in a new process whose total passed the old one's: the difference of the
  // totals would say $0.38; the daemon's turn cost says $1.50, and Sonnet 5 answered.
  await expect(headers(page).last()).toContainText(/·\$1\.50·Sonnet 5$/);
  // Turn 1 has neither (an older daemon, or a cost the daemon could not tell): no guess
  // from the running total, no model from the thread's current one.
  const first = await reveal(page, headers(page));
  await expect(first).toContainText(/steps$/);
  await expect(first).not.toContainText("$");
  await expect(first).not.toContainText("Opus");
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

test("a follow-up takes a PDF: a tile, a chip with its pages, sent as [PDF: …]", async ({ page }) => {
  await openThread(page, "idle");
  const composer = page.getByTestId("thread-composer");
  const editor = composer.locator('[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type("Check");
  await expect(composer.getByTestId("thread-attach")).toHaveAttribute("aria-label", "Attach images or PDFs");
  await composer.getByTestId("thread-file-input").setInputFiles([{ name: "spec.pdf", mimeType: "application/pdf", buffer: testPdf(3) }]);
  await expect(composer.getByTestId("attachment")).toHaveAttribute("data-pages", "3");
  await expect(composer.getByTestId("prompt-chip")).toHaveAttribute("aria-label", "PDF attachment, spec.pdf, 3 pages");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args.text ?? "").toMatch(/^Check \[PDF: spec\.pdf; ref=\S+-3p\.pdf\]$/);
});

test("a first message's PDFs: an inline chip with its pages, an unreferenced PDF tile, both open the paged preview", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  const input = page.getByTestId("composer-file-input");
  // Into the empty prompt: a tile only, so the message does not refer to it.
  await input.setInputFiles([{ name: "notes.pdf", mimeType: "application/pdf", buffer: testPdf(1) }]);
  await expect(page.getByTestId("attachment")).toHaveCount(1);
  await page.keyboard.type("Summarize");
  await input.setInputFiles([{ name: "spec.pdf", mimeType: "application/pdf", buffer: testPdf(2) }]);
  await expect(page.getByTestId("prompt-chip")).toHaveAttribute("aria-label", "PDF attachment, spec.pdf, 2 pages");
  await page.getByTestId("composer-input").press("Enter");

  const bubble = page.getByTestId("thread-user").first();
  await expect(bubble).toContainText("Summarize", { timeout: 8000 });
  const chip = bubble.locator('[data-tag-kind="pdf"]');
  await expect(chip).toHaveAttribute("aria-label", "PDF spec.pdf, 2 pages");
  await expect(chip).toContainText("2 pages");
  await expect(chip.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  // The unreferenced PDF is the one tile above the bubble, its first page over a "PDF" strip.
  const tiles = bubble.getByRole("list", { name: "Attached files" }).getByTestId("thread-attachment");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toHaveAttribute("data-kind", "pdf");
  await expect(tiles.first()).toHaveAttribute("data-pages", "1");
  await expect(tiles.first()).toContainText("PDF");
  await expect(tiles.first().locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  // The chip opens the preview: name, size and pages, a drawn canvas per page.
  const preview = page.getByTestId("thread-attachment-preview");
  await chip.click();
  await expect(preview).toHaveAttribute("data-kind", "pdf");
  await expect(page.getByTestId("thread-attachment-preview-name")).toHaveText("spec.pdf");
  await expect(page.getByTestId("thread-attachment-preview-size")).toHaveText("1 KB · 2 pages");
  const pages = preview.getByTestId("pdf-page");
  await expect(pages).toHaveCount(2);
  await expect(pages.locator("canvas")).toHaveCount(2);
  await expect(pages.first()).toHaveAttribute("data-rendered", "true");
  await pages.nth(1).scrollIntoViewIfNeeded();
  await expect(pages.nth(1)).toHaveAttribute("data-rendered", "true");
  await shot(page, "thread-pdf-preview");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);

  // So does the tile.
  await tiles.first().getByRole("button").click();
  await expect(page.getByTestId("thread-attachment-preview-size")).toHaveText("1 KB · 1 page");
  await expect(preview.getByTestId("pdf-page")).toHaveCount(1);
  await expect(preview.getByTestId("pdf-page").first()).toHaveAttribute("data-rendered", "true");
  await page.getByTestId("thread-attachment-preview-close").click();
  await expect(preview).toHaveCount(0);
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
  expect(send?.context).toMatchObject({ activeThreadId: "s-r1", activeView: "thread" });
  await expect(page.getByTestId("thread-user").last()).toContainText("Ship it with");
  await expect(page.getByTestId("thread-user").last().locator('[data-tag-kind="skill"]')).toHaveText("/review");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
  await expect(headers(page)).toHaveCount(3);
  // The draft cleared; every finished turn folded, the latest (the reply) included.
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "");
  await expect(headers(page).nth(0)).toHaveAttribute("data-folded", "true");
  await expect(headers(page).nth(1)).toHaveAttribute("data-folded", "true");
  await expect(headers(page).nth(2)).toHaveAttribute("data-folded", "true");
  // The prompt has focus again after the send (it is read-only while the send is in flight).
  await expect(editor).toBeFocused();
  await page.keyboard.type("x");
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "x");
});

test("the prompt is focused again after a send from the Send button", async ({ page }) => {
  await openThread(page, "idle");
  const editor = page.getByTestId("thread-composer").locator('[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type("And the tests");
  await page.getByTestId("thread-send").click();
  await expect.poll(calls).toContain("send s-r1 And the tests");
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "");
  await expect(editor).toBeFocused();
  // Typing goes straight into the prompt.
  await page.keyboard.type("next");
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "next");
});

test("scrolled up, a Jump to bottom chip floats above the composer; a click scrolls down and re-pins", async ({ page }) => {
  await openThread(page, "idle");
  const timeline = page.getByTestId("thread-timeline");
  const chip = page.getByTestId("thread-jump-bottom");
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await expect(chip).toBeHidden();

  const box = await timeline.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  await page.mouse.wheel(0, -600);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("Jump to bottom");
  // Centred, clear of the composer.
  await expect
    .poll(async () => {
      const c = await chip.boundingBox();
      const composer = await page.getByTestId("thread-composer").boundingBox();
      const t = await timeline.boundingBox();
      return !!c && !!composer && !!t && c.y + c.height <= composer.y && Math.abs(c.x + c.width / 2 - (t.x + t.width / 2)) <= 2;
    })
    .toBe(true);
  await shot(page, "thread-jump-bottom");

  await chip.click();
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await expect(chip).toBeHidden();
  // Pinned again: a new turn keeps the list at the bottom.
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.type("more");
  await page.keyboard.press("Enter");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await expect(chip).toBeHidden();
});

test("Interrupt stops the running turn (thread.interrupt)", async ({ page }) => {
  await openThread(page, "streaming");
  await page.getByTestId("thread-interrupt").click();
  await expect.poll(calls).toContain("interrupt s-r1");
  await expect(headers(page).last()).toContainText("Interrupted");
  await expect(page.getByTestId("thread-interrupt")).toHaveCount(0);
});

test("only the visible thread holds a Watch; a page holds none", async ({ page }) => {
  await openThread(page, "idle");
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
  expect((await openStreams())["TerminalService/Attach"] ?? 0).toBe(0);
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(0);
  await row(page, "s:s-r1").click();
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
  // Another thread: its Watch replaces this one.
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
  expect((await openStreams())["TerminalService/Attach"] ?? 0).toBe(0);
});

test("the thread.* commands are offered for a thread, not for a page", async ({ page }) => {
  await openThread(page, "idle");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Interrupt Thread");
  await expect(page.getByRole("option", { name: /Interrupt Thread/ })).toBeVisible();
  for (const title of ["Send to Thread", "Answer Thread Request", "Set Thread Effort"]) {
    await page.getByTestId("palette").getByRole("combobox").fill(title);
    await expect(page.getByRole("option", { name: new RegExp(title) })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  // Every thread has them: the seeded s-3 too, stopped.
  await row(page, "s:s-3").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-3");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Send to Thread");
  await expect(page.getByRole("option", { name: /Send to Thread/ })).toBeVisible();
  await page.keyboard.press("Escape");
  // A page has none of them.
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Thread");
  await expect(page.getByRole("option", { name: /New Thread/ })).toBeVisible();
  for (const title of ["Interrupt Thread", "Send to Thread", "Answer Thread Request", "Set Thread Model"]) {
    await expect(page.getByRole("option", { name: new RegExp(title) })).toHaveCount(0);
  }
});

test("a claude that did not start: its error in the timeline, the composer, and the next message starts it", async ({ page }) => {
  await openThread(page, "crashed");
  await expect(pane(page).getByTestId("thread-error")).toHaveText("Claude did not start: exit code 1: error: unknown option '--bogus'");
  await expect(row(page, "s:s-r1").getByTestId("row-status")).toHaveText("Error · did not start");
  await expect(page.getByTestId("thread-disconnected")).toHaveCount(0);
  const composer = page.getByTestId("thread-composer");
  await expect(composer).toBeVisible();
  await shot(page, "crashed");
  await composer.getByTestId("composer-input").click();
  await page.keyboard.type("Try again");
  await page.keyboard.press("Enter");
  // While Claude starts the timeline shows the same live header as a turn, no "starting" word.
  const working = page.getByTestId("thread-working");
  await expect(working).toContainText("Working");
  await expect(pane(page)).not.toContainText(/Starting Claude|starting…/);
  await shot(page, "starting");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.", { timeout: 10_000 });
  await expect(working).toHaveCount(0, { timeout: 5000 });
  await expect(pane(page).getByTestId("thread-error")).toBeVisible();
});

test("a stopped thread at its prompt keeps its conversation, the composer and the cold-cache note", async ({ page }) => {
  await openThread(page, "stopped");
  await expect(page.getByTestId("thread-disconnected")).toHaveCount(0);
  await expect(page.getByTestId("reconnect")).toHaveCount(0);
  const composer = page.getByTestId("thread-composer");
  await expect(composer.getByTestId("thread-cold-cache")).toHaveText(/^Cache expired · the next message re-reads 25\.7K tokens/);
  await expect(composer.getByTestId("thread-send")).toBeDisabled();
  await expect(headers(page).last()).toContainText("Sonnet 5");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("All 412 tests pass and the branch is pushed");
  await expect(page.getByTestId("thread-working")).toHaveCount(0);
  await expect(page.getByTestId("thread-empty")).toHaveCount(0);
  await expect(row(page, "s:s-r1").getByTestId("row-place")).toHaveAttribute("data-thread-badge", "idle");
});

test("a fork shows its parent's conversation, ended by a Forked from note", async ({ page }) => {
  await openThread(page, "idle");
  const parentHeaders = await headers(page).count();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Fork Thread");
  await page.keyboard.press("Enter");
  const fork = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(fork).not.toHaveAttribute("data-row-key", "s:s-r1");
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  const note = pane(page).getByTestId("thread-note");
  await expect(note).toHaveText("Forked from Fix stale PR badge");
  await expect(page.getByTestId("thread-working")).toContainText("Working");
  // The copied turns are all there (folded: the note is the latest row), and nothing waits.
  await expect(headers(page)).toHaveCount(parentHeaders);
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("All 412 tests pass and the branch is pushed");
  await expect(page.getByTestId("thread-working")).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByTestId("thread-empty")).toHaveCount(0);
  await shot(page, "fork-note");
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

test("a message sent mid-turn is a steer: it stays inside the running turn, which ends with one header", async ({ page }) => {
  await openThread(page, "streaming");
  const before = await headers(page).count();
  const editor = page.getByTestId("thread-composer").locator('[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type("Also say hi when you are done");
  await page.keyboard.press("Enter");
  await expect.poll(calls).toContain("send s-r1 Also say hi when you are done");
  // A smaller bubble inside the turn, not a new turn's message.
  const steer = pane(page).getByTestId("thread-steer");
  await expect(steer).toContainText("Also say hi when you are done");
  await expect(steer.getByTestId("thread-steer-caption")).toHaveText(/^sent mid-turn · \d/);
  await expect(pane(page).getByTestId("thread-user").filter({ hasText: "Also say hi" })).toHaveCount(0);
  // Claude answers it in the same turn: one header more, the turn folds, the steer stays.
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
  await expect(headers(page)).toHaveCount(before + 1);
  await expect(headers(page).last()).toHaveAttribute("data-folded", "true");
  await expect(steer).toBeVisible();
  await expect(headers(page).last()).toContainText("steps");
  await expect(pane(page).getByTestId("thread-user").filter({ hasText: "Also say hi" })).toHaveCount(0);
  await shot(page, "steer");
});
