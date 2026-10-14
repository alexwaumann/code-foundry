import { expect, test, type Locator, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row, writes } from "./fixtures";

/**
 * Copy and Run in terminal on a thread's code blocks (components/thread/CodeActions.tsx,
 * docs/notes/code-block-actions.md), over the mock's scripted thread s-r1. SHOTS=<dir>
 * saves screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

const pane = (page: Page) => page.getByTestId("thread-pane");
const bottom = (page: Page) => page.getByTestId("bottom-panel");
const host = (page: Page) => page.getByTestId("bottom-terminal-host");

/** Text the rest of the streaming answer ends with: the Go block closes, then a bash block. */
const CLOSE_GO = "ewDecision,\n\tHeadOid:     pr.HeadRefOid,\n\t}\n}\n```\n\nRun the package's tests:\n\n```bash\ngo test ./internal/store/pr/";
const BASH_CMD = "go test ./internal/store/pr/";

/** Whether the element is fully inside the thread timeline's visible area. */
async function inView(page: Page, el: Locator): Promise<boolean> {
  if ((await el.count()) === 0) return false;
  const [b, t] = await Promise.all([el.boundingBox(), page.getByTestId("thread-timeline").boundingBox()]);
  return b !== null && t !== null && b.y >= t.y && b.y + b.height <= t.y + t.height;
}

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

test("Run in terminal: hidden while the block streams, then a new shell in the thread's panel runs the command", async ({ page }) => {
  await streamToBash(page);
  // The Go block is finished: Copy only. The bash block is still being written: no Run yet.
  await expect(goBlock(page).getByTestId("code-copy")).toHaveCount(1);
  await expect(goBlock(page).getByTestId("code-run")).toHaveCount(0);
  await expect(bashBlock(page).getByTestId("code-run")).toHaveCount(0);

  await mockPost("thread/finish?rest=" + encodeURIComponent("\n```\n"));
  await expect(pane(page).locator('[data-testid="thread-text"][data-streaming]')).toHaveCount(0);
  const run = bashBlock(page).getByTestId("code-run");
  await expect(run).toHaveCount(1);
  // Hidden until the block is hovered (or a button has the keyboard).
  const actions = bashBlock(page).locator(".cf-code-actions");
  await expect(actions).toHaveCSS("opacity", "0");
  await bashBlock(page).hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(run).toHaveAttribute("title", "Run in terminal");
  await shot(page, "code-block-hover");

  await expect(bottom(page)).toHaveCount(0);
  await run.click();
  // One terminal.new with --run in the thread's context, nothing typed by the GUI.
  await expect
    .poll(async () => (await invocations()).filter((i) => i.name === "terminal.new").map((i) => ({ run: i.args.run, session: i.context?.activeSessionId })))
    .toEqual([{ run: BASH_CMD, session: "s-r1" }]);
  // A new tab in s-r1's panel, active, live, with the keyboard.
  await expect(bottom(page)).toBeVisible();
  await expect(bottom(page).getByRole("tab")).toHaveCount(1);
  const id = await host(page).getAttribute("data-terminal-id");
  expect(id).toMatch(/^t-new-/);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  // The panel took height from the pane; the timeline still shows its end (the block).
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
  await expect(bashBlock(page)).toBeInViewport();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="bottom-terminal-host"]') !== null))
    .toBe(true);
  // The daemon typed the command and Return into that shell, once.
  await expect.poll(async () => (await writes()).filter((w) => w.id === id)).toEqual([{ id, data: `${BASH_CMD}\r` }]);
  // Renderer-agnostic (WebGL has no DOM text): the bottom host is window.__cfTerminal.
  await expect.poll(() => screenText(page)).toContain(BASH_CMD);
  await shot(page, "code-block-ran");

  // Again: another fresh tab beside the first (the first stays open).
  await bashBlock(page).hover();
  await run.click();
  await expect(bottom(page).getByRole("tab")).toHaveCount(2);
  await expect(host(page)).not.toHaveAttribute("data-terminal-id", id ?? "");
});

test("Copy puts the raw code on the clipboard and shows Copied; a Bash row copies its command", async ({ page, browserName, context }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await streamToBash(page);
  await mockPost("thread/finish?rest=" + encodeURIComponent("\n```\n"));
  const copy = goBlock(page).getByTestId("code-copy");
  await goBlock(page).hover();
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied");
  await expect(copy).toHaveText("Copied");
  if (browserName === "chromium") {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("func fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{");
    expect(text).not.toContain("<span");
    expect(text.endsWith("}")).toBe(true);
  }
  await expect(copy).toHaveAttribute("aria-label", "Copy code", { timeout: 3000 });

  // The turn's last Bash row: its command line has Copy, never Run. The timeline follows
  // the bottom unless the user scrolls, so scroll it with the wheel. The turn folded when
  // it ended: show its work first.
  await pane(page).getByTestId("thread-footer").last().getByRole("button", { name: "Show this turn's work" }).click();
  const bash = pane(page).locator('[data-tool="Bash"]').last();
  await page.getByTestId("thread-timeline").hover();
  for (let i = 0; i < 40 && !(await inView(page, bash.locator("button[aria-expanded]").first())); i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(50);
  }
  await bash.locator("button[aria-expanded]").first().click();
  const cmd = bash.getByTestId("thread-bash");
  await cmd.hover();
  const copyCmd = cmd.getByTestId("code-copy");
  await expect(copyCmd).toHaveAttribute("aria-label", "Copy command");
  await expect(cmd.getByTestId("code-run")).toHaveCount(0);
  const shown = ((await cmd.locator(".cmd").textContent()) ?? "").replace(/^\$ /, "").replace(/Copied$/, "");
  await copyCmd.click();
  await expect(copyCmd).toHaveAttribute("aria-label", "Copied");
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  }
});

test("the buttons are keyboard reachable: focus shows them", async ({ page, browserName }) => {
  await streamToBash(page);
  await mockPost("thread/finish?rest=" + encodeURIComponent("\n```\n"));
  const run = bashBlock(page).getByTestId("code-run");
  await expect(bashBlock(page).locator(".cf-code-actions")).toHaveCSS("opacity", "0");
  await run.focus();
  await expect(bashBlock(page).locator(".cf-code-actions")).toHaveCSS("opacity", "1");
  // WebKit (like Safari and the Wails window) moves between buttons with Option+Tab.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(bashBlock(page).getByTestId("code-copy")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bashBlock(page).getByTestId("code-copy")).toHaveAttribute("aria-label", "Copied");
});
