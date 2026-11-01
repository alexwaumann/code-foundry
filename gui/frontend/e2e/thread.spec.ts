import { expect, test, type Locator, type Page } from "@playwright/test";
import { composeProject, invocations, leaveSidebar, mockPost, mockUrl, openApp, openStreams, resetMock, row, testPdf } from "./fixtures";

/**
 * A thread (components/thread, docs/notes/rendered-threads-2-gui.md) over the
 * mock's scripted "Fix stale PR badge" (mock/thread.ts). Set SHOTS=<dir> to save screenshots
 * (in both schemes: the light pass runs only then, except for the permission row's amber,
 * a colour checked in both).
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

/**
 * WebKit lets no test read the clipboard back: records what the app writes to it instead
 * (lib/clipboard.ts takes the writeText path when it exists).
 */
async function stubClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cfClipboard: string[] };
    w.__cfClipboard = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          w.__cfClipboard.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

const pane = (page: Page) => page.getByTestId("thread-pane");
/** Finished turns' headers (the running turn's live header is "thread-working" inside it). */
const headers = (page: Page) => page.locator('[data-testid="thread-turn-header"]:not([data-live])');

const schemes = process.env.SHOTS ? (["dark", "light"] as const) : (["dark"] as const);

for (const scheme of schemes) {
  test.describe(scheme, () => {
    // The rows themselves (the first message's tags, turn 1 folded with its header, the explore
    // groups, thinking, the question asked, the Write, the failing run, a Grep's matches, the
    // Edit's +6 and Copy diff, the subagent's one line and report, the answer's table and Go
    // highlighting, folding again): unit-tested in src/components/thread/timeline.test.tsx.
    // Left here: the virtual list reached by the user's wheel, @pierre/diffs' shadow root and the
    // table's computed header.
    test("the timeline: an earlier turn unfolded above the viewport, its Edit's diff, the answer's table", async ({ page }) => {
      await openThread(page, "permission", scheme);
      const first = headers(page).first();
      await expect(first).toHaveAttribute("data-folded", "true");
      // Above the viewport (the list sits at the bottom): the user scrolls up to it.
      await wheelUpTo(page, first);
      await first.locator("button.fold").click();
      await expect(first).not.toHaveAttribute("data-folded", "true");

      // The Edit: an inline unified diff from the result's structuredPatch.
      const edit = await reveal(page, pane(page).locator('[data-tool="Edit"]'));
      await edit.getByTestId("thread-tool").click();
      // @pierre/diffs renders in an open shadow root; Playwright's CSS locators pierce it.
      const code = edit.getByTestId("thread-diff").locator("[data-code]");
      await expect(code.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(6);
      await expect(code.locator('[data-line][data-line-type="change-deletion"]')).toHaveCount(1);
      await expect(code).toContainText("HeadRefOid");

      // The final answer's GFM table: framed, its header filled.
      const answer = await reveal(page, pane(page).locator('[data-testid="thread-text"][data-final]'));
      expect(await answer.locator(".cf-table th").first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await shot(page, `thread-timeline-${scheme}`);
    });

    // The live header heading the turn's work, the answer growing under it, the header turning
    // into the folded finished one in place, the answer's Copy and Copied: unit-tested in
    // src/components/thread/timeline.test.tsx, rows.test.tsx and src/lib/threadTimeline.test.ts.
    // Left here: the caret (::after), following the bottom while it streams, and the Copy
    // button's hover-only opacity (held while Copied).
    test("streaming: a caret while the answer grows, the view following it; the answer's Copy shows on hover", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const streaming = pane(page).locator('[data-testid="thread-text"][data-streaming]');
      await expect(streaming).toContainText("ReviewState: pr.Revi");
      const caret = await streaming.locator(".cf-streaming pre code").evaluate((el) => getComputedStyle(el, "::after").content);
      expect(caret).toBe('""');
      await shot(page, `thread-streaming-${scheme}`);

      await mockPost("thread/delta?text=" + encodeURIComponent("ewDecision,\n"));
      await expect(streaming).toContainText("ReviewState: pr.ReviewDecision,");
      // The view follows the bottom while it streams.
      await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");

      await mockPost("thread/finish");
      await expect(headers(page)).toHaveCount(1);
      const answer = pane(page).locator('[data-testid="thread-text"][data-final]').last();
      // The answer copies from a button shown while it is hovered.
      const copy = answer.getByRole("button", { name: "Copy answer" });
      await expect(copy).toHaveCSS("opacity", "0");
      await answer.hover();
      await expect(copy).toHaveCSS("opacity", "1");
      // A copy flips it to "Copied", shown even once the pointer leaves.
      await stubClipboard(page);
      await copy.click();
      const copied = answer.getByTestId("thread-copy-answer");
      await expect(copied).toHaveAttribute("aria-label", "Copied");
      await page.mouse.move(0, 0);
      await expect(copied).toHaveCSS("opacity", "1");
      await expect(copied).toHaveAttribute("aria-label", "Copy answer", { timeout: 3000 });
      await expect(copied).toHaveCSS("opacity", "0");
    });

    test("the latest turn folds when it ends and keeps its header and answer in view; only the user's scroll unpins the list", async ({ page }) => {
      // Tall enough for the folded turn, which keeps its texts (thread-fold-5-text-and-html).
      await page.setViewportSize({ width: 1280, height: 1100 });
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
      await expect(header).toContainText(/Worked for .*·9 steps·\$0\.04·Opus 4\.8/);
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

    test("scrolled up when the turn ends: it stays open in place, its header now Worked for; Jump to bottom folds it", async ({ page }) => {
      await openThread(page, "streaming", scheme);
      const timeline = page.getByTestId("thread-timeline");
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      // The user's wheel unpins (up to the running turn's header, into its work): the
      // streamed text no longer moves the list.
      const live = pane(page).locator('[data-testid="thread-turn-header"][data-live]');
      await wheelUpTo(page, live);
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      const top = await timeline.evaluate((el) => el.scrollTop);
      await mockPost("thread/delta?text=" + encodeURIComponent("ewDecision,\n"));
      await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toContainText("ReviewState: pr.ReviewDecision,");
      expect(await timeline.evaluate((el) => el.scrollTop)).toBe(top);

      // The turn ends: nothing folds under the reader. The header turns into the finished
      // one in place (same element, same y) and the work row under it stays where it was.
      const element = await live.elementHandle();
      const liveRow = live.locator("xpath=ancestor::*[@data-index][1]");
      const work = pane(page).locator(`[data-index="${(await liveRow.getAttribute("data-index")) ?? ""}"] + [data-index]`);
      await expect(work).not.toHaveAttribute("data-row-type", "user");
      const y = async (l: Locator) => Math.round((await l.boundingBox())?.y ?? -1);
      const before = { header: await y(liveRow), work: await y(work) };
      // No flash: the header is never folded on the way (decided before the rows render).
      await element.evaluate((el) => {
        const w = window as unknown as { foldedSeen: boolean };
        w.foldedSeen = false;
        new MutationObserver(() => {
          if (el.getAttribute("data-folded") === "true") w.foldedSeen = true;
        }).observe(el, { attributes: true });
      });
      await mockPost("thread/finish");
      const header = headers(page).last();
      await expect(header).toContainText(/^Worked for .*·9 steps·\$0\.04·Opus 4\.8/);
      await expect(header).not.toHaveAttribute("data-folded", "true");
      await expect(header.locator("button.fold")).toHaveAttribute("aria-expanded", "true");
      expect(await element.evaluate((el) => el.isConnected && !el.hasAttribute("data-live"))).toBe(true);
      await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
      await expect.poll(async () => [await y(header.locator("xpath=ancestor::*[@data-index][1]")), await y(work)]).toEqual([before.header, before.work]);
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      expect(await page.evaluate(() => (window as unknown as { foldedSeen: boolean }).foldedSeen)).toBe(false);
      await shot(page, `thread-open-on-end-${scheme}`);

      // Jump to bottom pins the list again: the turn folds there, its header and answer in view
      // (in a window tall enough for the folded turn, which keeps its texts).
      await page.setViewportSize({ width: 1280, height: 1100 });
      await page.getByTestId("thread-jump-bottom").click();
      await expect(header).toHaveAttribute("data-folded", "true");
      await expect(pane(page).locator('[data-tool="Edit"]')).toHaveCount(0);
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      const answer = pane(page).locator('[data-testid="thread-text"][data-final]').last();
      await expect
        .poll(async () => {
          const h = await header.boundingBox();
          const a = await answer.boundingBox();
          const t = await timeline.boundingBox();
          const composer = await page.getByTestId("thread-composer").boundingBox();
          return !!h && !!a && !!t && !!composer && h.y >= t.y && h.y < a.y && a.y + a.height <= composer.y;
        })
        .toBe(true);
    });

    test("reading the answer when the turn ends: nothing moves; scrolling back to the bottom folds the work", async ({ page }) => {
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
      const height = await timeline.evaluate((el) => el.scrollHeight);
      const text = pane(page).locator('[data-testid="thread-text"][data-final]').last();
      await mockPost("thread/finish");
      await expect(answer).toHaveCount(0);
      await expect(text).toContainText("I have not pushed.");
      await expect.poll(async () => Math.round((await text.boundingBox())?.y ?? -1)).toBe(Math.round(before?.y ?? 0));
      await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
      // Still open: the list's height grew by the answer's rest, it lost no work rows.
      expect(await timeline.evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(height);

      // The user scrolls back down: at the bottom the list pins and the turn folds.
      for (let i = 0; i < 40 && (await timeline.getAttribute("data-at-bottom")) !== "true"; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(50);
      }
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
      const header = headers(page).last();
      await expect(header).toContainText(/·\$0\.04·Opus 4\.8/);
      await expect(header).toHaveAttribute("data-folded", "true");
      await expect.poll(async () => timeline.evaluate((el) => el.scrollHeight)).toBeLessThan(height);
      await expect(timeline).toHaveAttribute("data-at-bottom", "true");
    });
  });
}

// The waiting row's text, the docked prompt's texts and buttons, the one Interrupt and the
// sidebar's Permission line: unit-tested in src/components/thread/timeline.test.tsx,
// PendingPrompt.test.tsx, ThreadComposer.test.tsx and src/components/sidebar/SidebarRow.test.tsx.
// Left here, in both schemes: the waiting word's amber (a theme colour) and the prompt's place.
for (const scheme of ["dark", "light"] as const) {
  test.describe(scheme, () => {
    test("a pending permission docks above the editor; the timeline's waiting word is amber", async ({ page }) => {
      await openThread(page, "permission", scheme);
      const waiting = pane(page).locator('[data-waiting="true"]');
      const color = await waiting.getByTestId("thread-waiting").evaluate((el) => getComputedStyle(el).color);
      expect(color).not.toBe(await waiting.locator(".lbl").evaluate((el) => getComputedStyle(el).color));
      const composer = page.getByTestId("thread-composer");
      const promptBox = await composer.getByTestId("thread-permission").boundingBox();
      const editorBox = await composer.getByTestId("composer-prompt").boundingBox();
      expect(promptBox && editorBox && promptBox.y + promptBox.height <= editorBox.y + 1).toBe(true);
      await shot(page, `thread-permission-${scheme}`);
    });
  });
}

test("reading deep into an open tool row when the turn ends: the row stays open where it is until Jump to bottom folds the turn", async ({ page }) => {
  await openThread(page, "streaming");
  const timeline = page.getByTestId("thread-timeline");
  // A long answer below the work, so there is room to keep the place.
  const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i)}`).join("\n\n");
  await mockPost("thread/delta?text=" + encodeURIComponent(`ewDecision,\n}\n\`\`\`\n\n${lines}\n`));
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toContainText("line 59");
  // The run of work with the Edit is a strip while the turn runs: expanded first, the
  // same way (pinned, above the viewport).
  await pane(page)
    .getByTestId("thread-strip-row")
    .evaluate((b) => {
      (b as HTMLElement).click();
    });
  await expect(pane(page).getByTestId("thread-strip")).toHaveAttribute("data-open", "true");
  // The Edit row open (its diff is a few hundred px tall). Pinned, the list stays at the
  // bottom, so the row is clicked where it is (above the viewport).
  const edit = pane(page).locator('[data-tool="Edit"]').last();
  await edit.getByTestId("thread-tool").evaluate((b) => {
    (b as HTMLElement).click();
  });
  await expect(edit.getByTestId("thread-tool")).toHaveAttribute("aria-expanded", "true");
  const row = edit.locator("xpath=ancestor::*[@data-index][1]");
  // The diff lays out a frame or two after the row opens (later under load).
  await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThan(200);
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
  const editRow = edit.getByTestId("thread-tool");
  const head = (await pane(page).getByTestId("thread-strip-head").boundingBox())?.height ?? 0;
  const before = ((await editRow.boundingBox())?.y ?? 0) - (box?.y ?? 0);
  await mockPost("thread/finish");
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
  await expect(pane(page).getByTestId("thread-strip")).toHaveCount(0);
  // The row the user reads stays open, where it was: the strip's rows take its place, so
  // it moves up by the strip's head only.
  await expect(editRow).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => Math.abs(((await editRow.boundingBox())?.y ?? -1000) - (box?.y ?? 0) - (before - head))).toBeLessThanOrEqual(1);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  await page.getByTestId("thread-jump-bottom").click();
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await expect(pane(page).locator('[data-tool="Edit"]')).toHaveCount(0);
  await expect(headers(page).last()).toHaveAttribute("data-folded", "true");
});

// Leaving a thread forgetting how it was folded (every finished turn folded, the rows the reader
// opened closed): unit-tested in src/components/thread/timeline.test.tsx. Left here: back on
// it, the list is pinned at the bottom again.
test("leaving a thread scrolled up: back on it, the list is pinned at the bottom with the turn folded", async ({ page }) => {
  await openThread(page, "streaming");
  const timeline = page.getByTestId("thread-timeline");
  await leaveSidebar(page, timeline);
  const box = await timeline.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  await page.mouse.wheel(0, -400);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  await mockPost("thread/finish");
  await expect(page.getByTestId("thread-working")).toHaveCount(0);

  await row(page, "s:s-2").click();
  await expect(pane(page)).toHaveAttribute("data-thread-id", "s-2");
  await row(page, "s:s-r1").click();
  await expect(pane(page)).toHaveAttribute("data-thread-id", "s-r1");
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await expect(headers(page).last()).toHaveAttribute("data-folded", "true");
});

// The live tool strip (one row per run of work in the running turn, "N steps", expanding in
// place, gone once the turn ends): src/components/thread/rows.test.tsx ("a live tool strip"),
// src/lib/threadTimeline.test.ts ("live tool strip (stripRuns)"; finished turns unchanged) and
// src/components/thread/activity.test.ts (strips on while the thread is on a turn). This keeps
// the open strip's screenshots.
for (const scheme of ["dark", "light"] as const) {
  test(`SHOTS: the live tool strip open (${scheme})`, async ({ page }) => {
    test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
    await openThread(page, "streaming", scheme);
    const strip = pane(page).getByTestId("thread-strip");
    await wheelUpTo(page, strip);
    await strip.getByTestId("thread-strip-row").click();
    await expect(strip).toHaveAttribute("data-open", "true");
    await shot(page, `thread-strip-open-${scheme}`);
  });
}

test("a click on a header folds or unfolds its turn without moving the header on screen", async ({ page }) => {
  // Tall enough for the whole folded thread: the list sits at the bottom (pinned) with the
  // first turn's header (9 steps) on screen.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await openThread(page, "idle");
  const timeline = page.getByTestId("thread-timeline");
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  const header = headers(page).first();
  await expect(header).toHaveAttribute("data-folded", "true");
  await expect(header).toContainText("9 steps");
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

// Headers with the daemon's turn cost and model (none for a turn without them), a pending
// question docked with its pager (and its timeline row), a follow-up taking a PDF sent as
// [PDF: …]: unit-tested in src/components/thread/timeline.test.tsx, PendingPrompt.test.tsx and
// ThreadComposer.test.tsx (the composer's own PDF flow: e2e/compose.spec.ts).

// The bubble's PDF chip (its pages and thumbnail), the unreferenced tile, the preview's name,
// size and pages: unit-tested in src/components/thread/UserBubble.test.tsx. Left here: pdf.js
// drawing the sent PDFs' thumbnails and pages, a page drawn as it scrolls into view.
test("a first message's PDFs: pdf.js draws the chip's and the tile's thumbnails and the preview's pages", async ({ page }) => {
  await openApp(page);
  await composeProject(page);
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
  await expect(chip.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  const tiles = bubble.getByRole("list", { name: "Attached files" }).getByTestId("thread-attachment");
  await expect(tiles.first().locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  // The chip's preview: a drawn canvas per page.
  const preview = page.getByTestId("thread-attachment-preview");
  await chip.click();
  const pages = preview.getByTestId("pdf-page");
  await expect(pages).toHaveCount(2);
  await expect(pages.locator("canvas")).toHaveCount(2);
  await expect(pages.first()).toHaveAttribute("data-rendered", "true");
  await pages.nth(1).scrollIntoViewIfNeeded();
  await expect(pages.nth(1)).toHaveAttribute("data-rendered", "true");
  await shot(page, "thread-pdf-preview");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);

  // So does the tile's.
  await tiles.first().getByRole("button").click();
  await expect(preview.getByTestId("pdf-page")).toHaveCount(1);
  await expect(preview.getByTestId("pdf-page").first()).toHaveAttribute("data-rendered", "true");
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
  // The row's hover card outlives the click and would take the wheel.
  await leaveSidebar(page, timeline);

  const box = await timeline.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  await page.mouse.wheel(0, -600);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("Jump to bottom");
  // Centred on the composer (the space left of the list's scrollbar gutter), clear of it.
  await expect
    .poll(async () => {
      const c = await chip.boundingBox();
      const composer = await page.getByTestId("thread-composer").boundingBox();
      return !!c && !!composer && c.y + c.height <= composer.y && Math.abs(c.x + c.width / 2 - (composer.x + composer.width / 2)) <= 2;
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

// The thread.* commands offered for a thread, not for a page: the daemon's availability rule
// (internal/command/commands_thread_test.go TestThreadCommandsAvailability); the GUI's part,
// the selection's context and the palette leaving out what is not available:
// src/stores/context.test.ts and src/keys/bindings.test.ts (inPalette).

// A claude that did not start (its error row, the sidebar's Error and "did not start", the live
// header with no starting word once a message goes, the error kept): unit-tested in
// src/components/thread/timeline.test.tsx and src/components/sidebar/SidebarRow.test.tsx; the
// restart on the next message is the daemon's.
test("a claude that did not start (screenshots)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  await openThread(page, "crashed");
  await expect(pane(page).getByTestId("thread-error")).toBeVisible();
  await shot(page, "crashed");
  await page.getByTestId("thread-composer").getByTestId("composer-input").click();
  await page.keyboard.type("Try again");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-working")).toContainText("Working");
  await shot(page, "starting");
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

// The follow-up placeholder by whether Claude works, with the one Interrupt; a message sent
// mid-turn going through thread.send and showing as a steer inside the running turn (one
// header when it ends): unit-tested in src/components/thread/ThreadComposer.test.tsx,
// rows.test.tsx and src/lib/threadTimeline.test.ts.
test("a steer (screenshot)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  await openThread(page, "streaming");
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.type("Also say hi when you are done");
  await page.keyboard.press("Enter");
  await expect(pane(page).locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
  await expect(pane(page).getByTestId("thread-steer")).toBeVisible();
  await shot(page, "steer");
});
