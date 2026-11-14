import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row, threadPrompt, writes } from "./fixtures";
import { attachStreams, inXterm, openQuick, quickHost, terminalTabs } from "./shell-terminals";

// The terminal's find (docs/notes/terminal-find.md) in the real xterm, on a terminal tab and on
// the quick terminal: chords through the keymap, the keyboard moving, and what is painted. The
// bar's states, which command a chord runs, the rebinds and the count's rules are vitest
// (src/keys/bindings.test.ts, src/components/terminal/TerminalFindBar.test.tsx, src/terminal/find.test.ts).

/** The terminal tab shown (its pane mounts only its active tab). */
const host = (page: Page) => page.getByTestId("shell-terminal-host");
const bar = (page: Page) => page.getByTestId("terminal-find");
const field = (page: Page) => page.getByTestId("terminal-find-input");
const count = (page: Page) => page.getByTestId("terminal-find-count");
const tabs = (page: Page) => terminalTabs(page).getByRole("tab");
/** The current match's outline: the one decoration the addon draws an element's border on. */
const current = (page: Page) => page.locator('.xterm-find-result-decoration[style*="outline"]');

// Not "resize": the mock's prompts have fix-resize in their path.
const LOG = "a zebra here\r\nZebra there\r\nthe last zebra\r\n";

async function print(id: string, text: string): Promise<void> {
  const res = await fetch(`${mockUrl}/__mock/terminal/print?id=${id}`, { method: "POST", body: text });
  expect(res.ok).toBe(true);
}

/** Output reached the grid. */
async function printed(page: Page, id: string, text: string, last: string): Promise<void> {
  await print(id, text);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cfTerminal?: { renderer: { getText(): string } } }).__cfTerminal?.renderer.getText() ?? "")).toContain(last);
}

/** Thread s-3 with a new terminal tab linked to it (cmd+t) in a pane beside it, the keyboard in it. Its id. */
async function shell(page: Page): Promise<string> {
  await openApp(page);
  await row(page, "s:s-3").click();
  // cmd+t reads the focused tab's thread, not the sidebar's selection (shell-25c-keys-drafts.md):
  // its tab first, or the chord opens a free home terminal.
  await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-3"]')).toBeVisible();
  await page.keyboard.press("Meta+t");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => inXterm(page)).toBe(true);
  return (await host(page).getAttribute("data-terminal-id")) ?? "";
}

test.beforeEach(async () => {
  await resetMock();
});

test("cmd+f takes the keyboard from xterm; what is typed stays out of the PTY; Escape gives it back", async ({ page }) => {
  const id = await shell(page);
  await printed(page, id, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
  await page.keyboard.type("zebra");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("3 of 3");
  expect((await writes()).filter((w) => w.id === id)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(() => inXterm(page)).toBe(true);
  await expect(page.locator(".xterm-find-result-decoration")).toHaveCount(0);
  await page.keyboard.type("x");
  await expect.poll(async () => (await writes()).filter((w) => w.id === id).map((w) => w.data).join("")).toBe("x");
});

test("cmd+f follows the keyboard: the thread's in its prompt, the terminal's in the terminal", async ({ page }) => {
  await shell(page);
  await threadPrompt(page).click();
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("thread-find-input")).toBeFocused();
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await host(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
});

test("from xterm with the bar open, cmd+f selects the query and cmd+g steps without taking the keyboard", async ({ page }) => {
  const id = await shell(page);
  await printed(page, id, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  await host(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
  // The click dropped the selection the addon goes on from: the next step is the first match.
  await page.keyboard.press("Meta+g");
  await expect(count(page)).toHaveText("1 of 3");
  await page.keyboard.press("Meta+g");
  await expect(count(page)).toHaveText("2 of 3");
  await page.keyboard.press("Meta+Shift+g");
  await expect(count(page)).toHaveText("1 of 3");
  expect(await inXterm(page)).toBe(true);
  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  expect(await field(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
});

test("the bar floats at the terminal's top right, over it and inside it", async ({ page }) => {
  await shell(page);
  await page.keyboard.press("Meta+f");
  const b = await bar(page).boundingBox();
  const h = await host(page).boundingBox();
  if (!b || !h) throw new Error("no box");
  expect(b.y - h.y).toBeLessThan(12);
  expect(h.x + h.width - (b.x + b.width)).toBeLessThan(16);
  expect(b.x).toBeGreaterThan(h.x);
});

test("the current match is outlined in the theme's warning colour, in WebGL and the DOM fallback, and follows a theme change", async ({ page }) => {
  const id = await shell(page);
  await printed(page, id, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  const outline = () => current(page).evaluate((el) => (el as HTMLElement).style.outlineColor);
  const warning = (hex: string) =>
    page.evaluate((v) => {
      document.documentElement.style.setProperty("--cf-warning", v);
    }, hex);
  await warning("#ff0000");
  await expect.poll(outline).toBe("rgb(255, 0, 0)");
  // A theme change keeps the current match and the count.
  await expect(count(page)).toHaveText("3 of 3");

  // The DOM renderer draws a match's cells with its background.
  await page.evaluate(() => {
    (window as unknown as { __cfTerminal: { renderer: { disableWebgl(): void } } }).__cfTerminal.renderer.disableWebgl();
  });
  await expect(host(page)).toHaveAttribute("data-renderer", "dom");
  await warning("#00ff00");
  await expect.poll(outline).toBe("rgb(0, 255, 0)");
  const painted = () => host(page).locator(".xterm-rows span").evaluateAll((spans) => spans.filter((s) => (s as HTMLElement).style.backgroundColor !== "").length);
  await expect.poll(painted).toBe("zebra".length * 3);
  await page.keyboard.press("Escape");
  await expect.poll(painted).toBe(0);
});

test("a tab's query is its own and nothing crosses a tab switch", async ({ page }) => {
  const first = await shell(page);
  await printed(page, first, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");

  await host(page).locator(".xterm-screen").click();
  await page.keyboard.press("Meta+t");
  await expect(tabs(page)).toHaveCount(2);
  await expect(host(page)).not.toHaveAttribute("data-terminal-id", first);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator(".xterm-find-result-decoration")).toHaveCount(0);
  const second = (await host(page).getAttribute("data-terminal-id")) ?? "";
  await printed(page, second, "only one yak here\r\n", "one yak");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("yak");
  await expect(count(page)).toHaveText("1 of 1");

  await tabs(page).first().click();
  await expect(host(page)).toHaveAttribute("data-terminal-id", first);
  await expect(field(page)).toHaveValue("zebra");
  // Counted again in this tab's snapshot, once, and not the other's.
  await expect(count(page)).toHaveText("3 of 3");
  await expect(page.locator(".xterm-find-result-decoration").first()).toBeAttached();

  await tabs(page).nth(1).click();
  await expect(field(page)).toHaveValue("yak");
  await expect(count(page)).toHaveText("1 of 1");
});

test("the count follows new output, and a reattach counts the snapshot once", async ({ page }) => {
  const id = await shell(page);
  await printed(page, id, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  await print(id, "one more zebra\r\n");
  await expect(count(page)).toHaveText("3 of 4");
  const reattach = () =>
    page.evaluate((t) => {
      const c = (window as unknown as { __cfTerminal: { controller: { detach(): void; attach(id: string): void } } }).__cfTerminal.controller;
      c.detach();
      c.attach(t);
    }, id);
  await reattach();
  await expect(count(page)).toHaveText("4 of 4");
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
});

test("hiding the panel ends the stream and keeps the query; it comes back highlighted, the keyboard left in the terminal", async ({ page }) => {
  // The quick terminal: cmd+j from it closes it (its stream ends), cmd+j again brings it back.
  await openApp(page);
  await row(page, "s:s-3").click();
  await expect(threadPrompt(page)).toBeFocused();
  const id = await openQuick(page);
  await printed(page, id, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  await quickHost(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("quick-terminal")).toHaveCount(0);
  await expect.poll(attachStreams).toBe(0);
  await page.keyboard.press("Meta+j");
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(field(page)).toHaveValue("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  await expect(page.locator(".xterm-find-result-decoration").first()).toBeAttached();
  await expect.poll(() => inXterm(page)).toBe(true);
});

test("closing the tab takes its find with it", async ({ page }) => {
  await shell(page);
  await page.keyboard.press("Meta+t");
  await expect(tabs(page)).toHaveCount(2);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("zebra");
  // Back in the terminal with the bar open (a text field yields no cmd+w: shell-20-cutover.md, Keys),
  // cmd+w closes its tab, which ends the terminal.
  await host(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
  await page.keyboard.press("Meta+w");
  await expect(tabs(page)).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cfModule(p: string): Promise<{ useTerminalFindStore: { getState(): { byTerminal: object } } }> }).__cfModule("/src/stores/terminalFind.ts").then((m) => Object.keys(m.useTerminalFindStore.getState().byTerminal).length))).toBe(0);
});

test("it works on an exited terminal", async ({ page }) => {
  const id = await shell(page);
  await printed(page, id, LOG, "last zebra");
  await mockPost(`terminal/exit?id=${id}&code=1&keep=1`);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "exited");
  await host(page).locator(".xterm-screen").click();
  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("1 of 3");
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
});

test("the palette's Find in Terminal lands in the bar", async ({ page }) => {
  await shell(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Find in Terminal");
  await page.getByRole("option", { name: /Find in Terminal/ }).click();
  await expect(bar(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
});

test("in the alternate screen it sees the screen; back out, the scrollback", async ({ page }) => {
  const id = await shell(page);
  await printed(page, id, LOG, "last zebra");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("zebra");
  await expect(count(page)).toHaveText("3 of 3");
  await print(id, "\x1b[?1049h\x1b[H\x1b[2Jzebra on the alt screen");
  await expect(count(page)).toHaveText("1 of 1");
  await print(id, "\x1b[?1049l");
  await expect(count(page)).toHaveText("3 of 3");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1440x900 at 2x. */
test.describe("screenshots", () => {
  test.use({ deviceScaleFactor: 2 });
  for (const scheme of ["dark", "light"] as const) {
    test(`screenshots (${scheme})`, async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      const id = await shell(page);
      await printed(page, id, "$ go test ./internal/terminal/... -run Resize -race -count=20\r\n=== RUN   TestResizeDrainsPendingWrites\r\n--- PASS: TestResizeDrainsPendingWrites (0.04s)\r\n=== RUN   TestResizeDuringSnapshot\r\n    actor_test.go:212: snapshot held 3 writes past the resize\r\n\x1b[31m--- FAIL: TestResizeDuringSnapshot (0.11s)\x1b[0m\r\n=== RUN   TestResizeToZero\r\n--- PASS: TestResizeToZero (0.00s)\r\nFAIL\r\n", "FAIL");
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${String(shots)}/before-${scheme}.png` });
      await page.keyboard.press("Meta+f");
      await page.keyboard.type("resize");
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+Enter");
      await expect(count(page)).toHaveText("4 of 9");
      // The count is synchronous; the WebGL selection is drawn frames later.
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${String(shots)}/after-${scheme}.png` });
    });
  }
});

test("Ctrl-C reaches the prompt within seconds of a flood with the bar open on a word on every line", async ({ page }) => {
  // Each highlight is a marker that hears every line a full scrollback drops: kept through a
  // flood, they slowed xterm's parse to KB/s and Ctrl-C waited minutes behind it. Only a browser
  // parses at the real rate (the rules are vitest: src/terminal/find.test.ts).
  test.setTimeout(40_000);
  const id = await shell(page);
  await printed(page, id, "GET /api/items 200\r\n".repeat(31_000), "GET /api/items 200");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("GET");
  await expect(count(page)).toHaveText("20000+", { timeout: 10_000 });
  await host(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
  const res = await fetch(`${mockUrl}/__mock/terminal/flood?id=${id}`, { method: "POST", body: "GET flood line\r\n" });
  expect(res.ok).toBe(true);
  // Long enough for the old way to pile up megabytes behind the highlights.
  await page.waitForTimeout(6000);
  const cursorLine = () =>
    page.evaluate(() => {
      const term = (window as unknown as { __cfTerminal: { renderer: { term: { buffer: { active: { baseY: number; cursorY: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } } } }).__cfTerminal.renderer.term;
      const buf = term.buffer.active;
      return buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true).trim() ?? "";
    });
  expect(await cursorLine()).not.toBe("❯");
  await page.keyboard.press("Control+c");
  await expect.poll(cursorLine, { timeout: 4000 }).toBe("❯");
  await expect(bar(page)).toBeVisible();
});
