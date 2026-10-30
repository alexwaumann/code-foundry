import { expect, test, type Page } from "@playwright/test";
import { dragSelect, invocations, mockPost, openApp, openTooltip, resetMock, row, textPoints } from "./fixtures";

// Citations (docs/notes/citations.md): select text in one of Claude's answers, Cite,
// comment, and the citation lands in the composer as an amber chip; sent, the bubble
// draws the chip from its link and opens the quote with Go to source. Over the mock's
// idle s-r1 "Fix stale PR badge". SHOTS=<dir> saves screenshots.

test.beforeEach(async () => {
  await resetMock();
  await mockPost("thread?state=idle");
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const pane = (page: Page) => page.getByTestId("thread-pane");
const answer = (page: Page) => pane(page).locator('[data-testid="thread-text"][data-final]').last();
const citeButton = (page: Page) => page.getByTestId("cite-button");
const popover = (page: Page) => page.getByTestId("cite-popover");
const comment = (page: Page) => page.getByTestId("cite-comment");
const prompt = (page: Page) => page.getByTestId("thread-composer").getByTestId("composer-prompt");
const chips = (page: Page) => page.getByTestId("thread-composer").locator('[data-testid="prompt-tag"][data-tag-kind="cite"]');

const LAST = "All 412 tests pass and the branch is pushed: PR #63 picked up the fix.";

async function openThread(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(answer(page)).toContainText(LAST);
}

async function hasHighlight(page: Page, name: string): Promise<boolean> {
  return page.evaluate((n) => (globalThis as unknown as { CSS: { highlights?: Map<string, unknown> } }).CSS.highlights?.has(n) ?? document.querySelector(`[data-cite-overlay="${n}"]`) !== null, name);
}

test("select → Cite → comment → chip; edit from the chip; send; the bubble's popover goes to the source", async ({ page }) => {
  await openThread(page);
  const end = await dragSelect(page, answer(page), "the branch is pushed");
  await expect(citeButton(page)).toBeVisible();
  // 6px under the selection's last line, centred where the pointer let go.
  const btn = await citeButton(page).boundingBox();
  const line = await textPoints(answer(page), "pushed");
  expect(btn).not.toBeNull();
  if (btn) {
    expect(Math.abs(btn.x + btn.width / 2 - end.x)).toBeLessThan(3);
    expect(btn.y).toBeGreaterThan(line.to.y);
    expect(btn.y - line.to.y).toBeLessThan(20);
  }
  await shot(page, "cite-button");

  await citeButton(page).click();
  await expect(popover(page)).toBeVisible();
  await expect(comment(page)).toBeFocused();
  // The selection stays painted while the field has the keyboard.
  expect(await hasHighlight(page, "cf-cite-held")).toBe(true);
  await page.keyboard.type("Is it on main?");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Check the remote.");
  await expect(comment(page)).toHaveValue("Is it on main?\nCheck the remote.");
  await shot(page, "cite-comment");
  await page.keyboard.press("Enter");
  await expect(popover(page)).toHaveCount(0);
  expect(await hasHighlight(page, "cf-cite-held")).toBe(false);

  await expect(chips(page)).toHaveText(["the branch is pushed"]);
  const id = await chips(page).first().getAttribute("data-cite");
  await expect(prompt(page)).toHaveAttribute("data-value", `[Assistant quote](cf-cite://${id ?? ""}) `);
  // The prompt has the keyboard, the caret after the chip.
  await page.keyboard.type("is that right?");
  await expect(prompt(page)).toHaveAttribute("data-value", `[Assistant quote](cf-cite://${id ?? ""}) is that right?`);

  // Tooltip: the quote, then the comment.
  await page.mouse.move(0, 0);
  await chips(page).first().hover();
  await expect(openTooltip(page)).toContainText("the branch is pushed");
  await expect(openTooltip(page)).toContainText("Is it on main?");
  await page.mouse.move(0, 0);

  // A click on the chip: the quote painted amber, the popover open with the comment, the chip ringed.
  await chips(page).first().click();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page)).toHaveAttribute("data-editing", "");
  await expect(comment(page)).toHaveValue("Is it on main?\nCheck the remote.");
  // The field has the keyboard (not the prompt, where the click left the chip selected).
  await expect(comment(page)).toBeFocused();
  await expect(chips(page).first()).toHaveAttribute("data-editing", "");
  expect(await hasHighlight(page, "cf-cite-mark")).toBe(true);
  await shot(page, "cite-edit");
  await comment(page).fill("Is it on main?");
  await page.getByTestId("cite-save").click();
  await expect(popover(page)).toHaveCount(0);
  await expect(chips(page).first()).not.toHaveAttribute("data-editing", "");
  expect(await hasHighlight(page, "cf-cite-mark")).toBe(false);
  // Back in the prompt, the caret after the chip: typing does not replace it.
  await expect(page.getByTestId("thread-composer").locator('[contenteditable="true"]')).toBeFocused();
  await page.keyboard.type("Q");
  await expect(chips(page)).toHaveCount(1);
  await page.keyboard.press("Backspace");

  // Send: Claude gets the self-contained link.
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args.text ?? "").toMatch(/^\[Assistant quote\]\(cf-cite:\/\/v1\/s-r1\/s-r1-i\d+\?text=the%20branch%20is%20pushed&start=\d+&end=\d+&prefix=[^&]*&suffix=[^&]*&comment=Is%20it%20on%20main%3F\) is that right\?$/);
  const sent = (await invocations()).find((i) => i.name === "thread.send");
  const link = /cf-cite:\/\/v1\/[^)]+/.exec(sent?.args.text ?? "")?.[0] ?? "";
  const q = new URLSearchParams(link.slice(link.indexOf("?") + 1));
  expect(q.get("prefix")).toBe("All 412 tests pass and ");
  expect(q.get("suffix")).toBe(": PR #63 picked up the fix. The ");
  expect(Number(q.get("end")) - Number(q.get("start"))).toBe("the branch is pushed".length);

  // The bubble draws the chip; its popover shows the quote and goes to the source.
  const bubble = page.getByTestId("thread-user").last();
  const sentChip = bubble.locator('[data-tag-kind="cite"]');
  await expect(sentChip).toHaveText("the branch is pushed");
  await expect(page.locator('[data-testid="thread-text"]').last()).toContainText("Got it");
  await expect(async () => {
    await sentChip.click();
    await expect(page.getByTestId("cite-source")).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(page.getByTestId("cite-source-quote")).toHaveText("the branch is pushed");
  await expect(page.getByTestId("cite-source-comment")).toHaveText("Is it on main?");
  await expect(page.getByTestId("cite-source-meta")).toHaveText(/^Claude · \d{1,2}:\d{2}/);
  await shot(page, "cite-sent");
  // It hangs under the whole bubble, its left edge at the chip unless that would cross the window's edge.
  const [pop, bub, chip] = await Promise.all([page.getByTestId("cite-source").boundingBox(), bubble.locator(".bubble").boundingBox(), sentChip.boundingBox()]);
  const vw = page.viewportSize()?.width ?? 0;
  if (pop && bub && chip) {
    expect(pop.x).toBeLessThanOrEqual(chip.x + 1);
    expect(chip.x + pop.width <= vw - 12 ? Math.abs(pop.x - chip.x) : vw - 12 - (pop.x + pop.width)).toBeLessThan(2);
    expect(pop.y).toBeGreaterThanOrEqual(bub.y + bub.height);
  }
  await page.getByTestId("cite-go-to-source").click();
  await expect(page.getByTestId("cite-source")).toHaveCount(0);
  await expect.poll(() => hasHighlight(page, "cf-cite-mark")).toBe(true);
  await expect(answer(page).first()).toBeInViewport();
});

test("a selection that leaves its answer, or one in a bubble, shows no Cite button", async ({ page }) => {
  await openThread(page);
  // Inside a user bubble.
  await dragSelect(page, page.getByTestId("thread-user").last().locator(".bubble"), "Run the full suite");
  await page.waitForTimeout(150);
  await expect(citeButton(page)).toHaveCount(0);
  // From the answer up into the user bubble above it.
  const start = await textPoints(answer(page), "All 412");
  const into = await textPoints(page.getByTestId("thread-user").last().locator(".bubble"), "full suite");
  await page.mouse.move(start.to.x, start.to.y);
  await page.mouse.down();
  await page.mouse.move(into.from.x, into.from.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "")).toContain("full suite");
  await page.waitForTimeout(150);
  await expect(citeButton(page)).toHaveCount(0);
  // Back inside the answer: the button shows; a click elsewhere takes it away.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.waitForTimeout(100);
  await dragSelect(page, answer(page), "412 tests");
  await expect(citeButton(page)).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(citeButton(page)).toHaveCount(0);
});

test("Escape and a click outside cancel; an empty comment is fine", async ({ page }) => {
  await openThread(page);
  await dragSelect(page, answer(page), "412 tests pass");
  await citeButton(page).click();
  await expect(comment(page)).toBeFocused();
  await page.keyboard.type("never mind");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);

  await dragSelect(page, answer(page), "412 tests pass");
  await citeButton(page).click();
  await expect(comment(page)).toBeFocused();
  await page.getByTestId("thread-header").click({ position: { x: 300, y: 10 } });
  await expect(popover(page)).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);

  await dragSelect(page, answer(page), "412 tests pass");
  await citeButton(page).click();
  await page.keyboard.press("Enter");
  await expect(chips(page)).toHaveText(["412 tests pass"]);
  // Backspace removes it whole.
  await page.waitForTimeout(600); // ProseMirror groups edits within 500 ms into one undo step
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(chips(page)).toHaveCount(0);
  await page.keyboard.press("Meta+z");
  await expect(chips(page)).toHaveCount(1);
  await page.keyboard.press("End");
  await page.keyboard.type("ok");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args.text ?? "").toMatch(/^\[Assistant quote\]\(cf-cite:\/\/v1\/s-r1\/[^?]+\?text=412%20tests%20pass&start=\d+&end=\d+&prefix=[^&)]*&suffix=[^&)]*\) ok$/);
});

test("a chip whose answer is in a folded turn goes to it, the turn left folded; a quote no longer in the thread cannot go to its source", async ({ page }) => {
  await openThread(page);
  // Turn 1's intermediate text shows while the turn is folded (thread-fold-5-text-and-html).
  const header = page.getByTestId("thread-turn-header").first();
  await expect(header).toHaveAttribute("data-folded", "true");
  const mid = pane(page).locator('[data-testid="thread-text"]').filter({ hasText: "Now the fingerprint itself." });
  await expect(mid).toBeVisible();
  // Away from the list's edges (a drag near one autoscrolls it), by the user's wheel: the
  // list is pinned at the bottom and follows it back after a scroll nobody asked for.
  const box = await page.getByTestId("thread-timeline").boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  for (let i = 0; i < 40; i++) {
    const m = await mid.boundingBox();
    if (m && box && m.y >= box.y + 100 && m.y + m.height <= box.y + box.height - 100) break;
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(50);
  }
  await dragSelect(page, mid, "fingerprint itself");
  await citeButton(page).click();
  await page.keyboard.press("Enter");
  await expect(chips(page)).toHaveText(["fingerprint itself"]);
  // Scrolled away to the bottom, the chip brings the folded turn's text back into view.
  await page.getByTestId("thread-timeline").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await chips(page).first().click();
  await expect(popover(page)).toBeVisible();
  await expect(mid).toBeInViewport();
  expect(await hasHighlight(page, "cf-cite-mark")).toBe(true);
  await expect(header).toHaveAttribute("data-folded", "true");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);

  // A link to an item this thread does not have (pasted text sends as is; the bubble reads it).
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.querySelector('[data-testid="thread-composer"] [contenteditable="true"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "[Assistant quote](cf-cite://v1/s-r1/s-r1-gone?text=an%20old%20answer&start=0&end=13&prefix=&suffix=) gone?");
  await page.keyboard.press("Enter");
  const sentChip = page.getByTestId("thread-user").last().locator('[data-tag-kind="cite"]');
  await expect(sentChip).toHaveText("an old answer");
  await expect(page.locator('[data-testid="thread-text"]').last()).toContainText("Got it");
  await expect(async () => {
    await sentChip.click();
    await expect(page.getByTestId("cite-source")).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(page.getByTestId("cite-source-meta")).toHaveText("No longer in this thread");
  await expect(page.getByTestId("cite-go-to-source")).toBeDisabled();
});

test("a triple-click that ends at the next row's start cites the paragraph", async ({ page }) => {
  await openThread(page);
  const header = page.getByTestId("thread-turn-header").first();
  await header.evaluate((el) => (el.querySelector("button") ?? el).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const mid = pane(page).locator('[data-testid="thread-text"]').filter({ hasText: "Now the fingerprint itself." });
  await expect(mid).toBeVisible();
  await mid.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
  await mid.locator("p").first().click({ clickCount: 3 });
  await expect(citeButton(page)).toBeVisible();
  await citeButton(page).click();
  await page.keyboard.press("Enter");
  await expect(chips(page)).toHaveText(["Now the fingerprint…"]);
  await chips(page).first().hover();
  await expect(openTooltip(page)).toHaveText("Now the fingerprint itself.");
});

/** Pastes text into the thread composer's prompt. */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    document.querySelector('[data-testid="thread-composer"] [contenteditable="true"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test("Go to source is not replayed when the thread is shown again; a quote no draft has does not send", async ({ page }) => {
  await openThread(page);
  const item = (await answer(page).getAttribute("data-cite-item")) ?? "";
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await paste(page, `[Assistant quote](cf-cite://v1/s-r1/${encodeURIComponent(item)}?text=All%20412%20tests&start=0&end=13&prefix=&suffix=) ok`);
  await page.keyboard.press("Enter");
  const sentChip = page.getByTestId("thread-user").last().locator('[data-tag-kind="cite"]');
  await expect(page.locator('[data-testid="thread-text"]').last()).toContainText("Got it");
  await expect(async () => {
    await sentChip.click();
    await expect(page.getByTestId("cite-source")).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.getByTestId("cite-go-to-source").click();
  await expect.poll(() => hasHighlight(page, "cf-cite-mark")).toBe(true);
  await expect.poll(() => hasHighlight(page, "cf-cite-mark"), { timeout: 4000 }).toBe(false);
  await row(page, "s:s-1").click();
  await row(page, "s:s-r1").click();
  await expect(answer(page)).toBeVisible();
  await page.waitForTimeout(500);
  expect(await hasHighlight(page, "cf-cite-mark")).toBe(false);

  // A draft token whose body no draft has (copied from a composer that has sent it): an error, nothing sent.
  const before = (await invocations()).filter((i) => i.name === "thread.send").length;
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await paste(page, "[Assistant quote](cf-cite://c0123456789ab)");
  await expect(chips(page)).toHaveText(["Quote"]);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-composer-error")).toHaveText("Nothing to send: the quote is no longer in any draft.");
  expect((await invocations()).filter((i) => i.name === "thread.send")).toHaveLength(before);
});

test("with the thread info card shown, the Cite button and popover hang left of the card", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openThread(page);
  await page.getByTestId("thread-info-toggle").click();
  const card = await page.getByTestId("thread-info-card").boundingBox();
  if (!card) throw new Error("no card");
  // A selection let go over the card (the card lays over the body's right): the button is clamped to the conversation's side.
  const { from } = await textPoints(answer(page), "the branch is pushed");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(card.x + 60, from.y, { steps: 6 });
  await page.mouse.up();
  await expect(citeButton(page)).toBeVisible();
  const btn = await page.getByTestId("cite-button-surface").boundingBox();
  expect(btn).not.toBeNull();
  if (btn) expect(btn.x + btn.width).toBeLessThanOrEqual(card.x);
  await citeButton(page).click();
  await expect(popover(page)).toBeVisible();
  const pop = await popover(page).boundingBox();
  expect(pop).not.toBeNull();
  if (pop) expect(pop.x + pop.width).toBeLessThanOrEqual(card.x);
});
