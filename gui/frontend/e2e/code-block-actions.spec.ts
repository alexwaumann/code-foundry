import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row, writes } from "./fixtures";
import { keyboardIn, quickHost, terminalTabs } from "./shell-terminals";

/**
 * A thread's code blocks' header (components/thread/CodeActions.tsx, docs/notes/code-block-header.md):
 * always shown, Run into the thread's quick terminal (a new linked tab when it is busy), over
 * the mock's scripted thread s-r1. What the header holds is CodeActions.test.tsx's; here only
 * what a browser shows. SHOTS=<dir> saves screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

const pane = (page: Page) => page.getByTestId("thread-pane");
/** The terminal tab shown (its pane mounts only its active tab). */
const host = (page: Page) => page.getByTestId("shell-terminal-host");

/** Text the rest of the streaming answer ends with: the Go block closes, then a bash block. */
const CLOSE_GO = "ewDecision,\n\tHeadOid:     pr.HeadRefOid,\n\t}\n}\n```\n\nRun the package's tests:\n\n```bash\ngo test ./internal/store/pr/";
const BASH_CMD = "go test ./internal/store/pr/";

function screenText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __cfTerminal?: { renderer: { getText(): string } } }).__cfTerminal?.renderer.getText() ?? "");
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Thread s-r1 streaming its answer; the answer grows to a bash block, still open. */
async function streamToBash(page: Page): Promise<void> {
  await mockPost("thread?state=streaming");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(pane(page)).toBeVisible();
  await mockPost("thread/delta?text=" + encodeURIComponent(CLOSE_GO));
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming] pre[data-lang="bash"]')).toContainText(BASH_CMD);
}

const reply = (page: Page) => pane(page).locator('[data-testid="thread-text"]').last();
const bashBlock = (page: Page) => reply(page).locator(".cf-code").filter({ has: page.locator('pre[data-lang="bash"]') });
const goBlock = (page: Page) => reply(page).locator(".cf-code").filter({ has: page.locator('pre[data-lang="go"]') });

test("Run: the header is there while the block streams (no Run yet), then Run types into the thread's quick terminal, and into a new linked tab while that one is busy", async ({ page }) => {
  await streamToBash(page);
  // The Go block is finished: Copy only. The bash block is still being written: its header, no Run yet.
  await expect(goBlock(page).getByTestId("code-copy")).toHaveCount(1);
  await expect(goBlock(page).getByTestId("code-run")).toHaveCount(0);
  await expect(bashBlock(page).getByTestId("code-lang")).toHaveText("bash");
  await expect(bashBlock(page).getByTestId("code-run")).toHaveCount(0);
  await shot(page, "code-block-streaming");

  await mockPost("thread/finish?rest=" + encodeURIComponent("\n```\n"));
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
  const run = bashBlock(page).getByTestId("code-run");
  await expect(run).toHaveCount(1);
  // Shown with no pointer over the block: no hover reveal, no fade.
  await page.mouse.move(0, 0);
  await expect(bashBlock(page).getByTestId("code-head")).toHaveCSS("opacity", "1");
  await expect(run).toHaveCSS("opacity", "1");
  await expect(run).toHaveCSS("transition-duration", "0s");
  // The header sits above the code, not over it.
  const head = await bashBlock(page).getByTestId("code-head").boundingBox();
  const code = await bashBlock(page).locator("pre").boundingBox();
  expect(head && code && head.y + head.height <= code.y).toBe(true);
  await shot(page, "code-block-header");

  await expect(quickHost(page)).toHaveCount(0);
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
  await run.click();
  // terminal.new --quick --run in the thread's context, nothing typed by the GUI.
  await expect
    .poll(async () => (await invocations()).filter((i) => i.name === "terminal.new").map((i) => ({ quick: i.args.quick, run: i.args.run, thread: i.context?.activeThreadId })))
    .toEqual([{ quick: "true", run: BASH_CMD, thread: "s-r1" }]);
  // The quick terminal opens under the conversation, live, with the keyboard; no tab.
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
  await expect(terminalTabs(page)).toHaveCount(0);
  const quick = (await quickHost(page).getAttribute("data-terminal-id")) ?? "";
  await expect.poll(async () => (await writes()).filter((w) => w.id === quick)).toEqual([{ id: quick, data: `${BASH_CMD}\r` }]);
  // The thread stays in its pane, its timeline at its end above the quick terminal.
  await expect(pane(page)).toHaveAttribute("data-thread-id", "s-r1");
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
  await shot(page, "code-block-ran-quick");

  // Busy: a command still runs in the quick terminal. Run never types into it: a new tab linked to the thread runs it.
  await mockPost(`terminal/facts?id=${quick}&foreground=${encodeURIComponent(BASH_CMD)}`);
  await run.click();
  await expect(terminalTabs(page)).toHaveCount(1);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);
  const id = (await host(page).getAttribute("data-terminal-id")) ?? "";
  expect(id).toMatch(/^t-new-/);
  await expect.poll(async () => (await writes()).filter((w) => w.id === id)).toEqual([{ id, data: `${BASH_CMD}\r` }]);
  expect((await writes()).filter((w) => w.id === quick)).toHaveLength(1);
  // Renderer-agnostic (WebGL has no DOM text): the tab's host is window.__cfTerminal.
  await expect.poll(() => screenText(page)).toContain(BASH_CMD);
  await shot(page, "code-block-ran-busy");
});

test("Copied changes neither the header's height nor where its label and Run sit", async ({ page }) => {
  // WebKit lets no page write the clipboard unprompted here: the write resolves, as a user's click would.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
  });
  await streamToBash(page);
  await mockPost("thread/finish?rest=" + encodeURIComponent("\n```\n"));
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
  const block = bashBlock(page);
  await expect(block.getByTestId("code-run")).toHaveCount(1);
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
  const boxes = async () => ({
    head: await block.getByTestId("code-head").boundingBox(),
    lang: await block.getByTestId("code-lang").boundingBox(),
    run: await block.getByTestId("code-run").boundingBox(),
    copy: await block.getByTestId("code-copy").boundingBox(),
  });
  const before = await boxes();
  await block.getByTestId("code-copy").click();
  await expect(block.getByTestId("code-copy")).toHaveAttribute("data-copied", "true");
  await shot(page, "code-block-copied");
  expect(await boxes()).toEqual(before);
});

test("the buttons are keyboard reachable", async ({ page }) => {
  await streamToBash(page);
  await mockPost("thread/finish?rest=" + encodeURIComponent("\n```\n"));
  await bashBlock(page).getByTestId("code-run").focus();
  // WebKit (like Safari and the Wails window) moves between buttons with Option+Tab.
  await page.keyboard.press("Alt+Tab");
  await expect(bashBlock(page).getByTestId("code-copy")).toBeFocused();
});
