import { expect, test, type Page } from "@playwright/test";
import { composeProject, invocations, mockPost, openApp, openTooltip, resetMock, row } from "./fixtures";

// Thread tags under "@" (docs/notes/composer-thread-pr-tags.md): a "Threads" group above
// "Files" lists up to three active threads by name (not archived, not snoozed, never the
// thread being written in), from the thread list the GUI already holds. The mock's
// threads: s-3 "Fix resize race" (code-foundry, idle), s-7 "Spike a canvas sidebar"
// (archived), s-8 "Refactor the gh poller" (snoozed). Set SHOTS=<dir> for screenshots.

async function setFiles(project: string, files: readonly string[]): Promise<void> {
  await mockPost(`files?project=${project}&${files.map((f) => `path=${encodeURIComponent(f)}`).join("&")}`);
}

test.beforeEach(async () => {
  await resetMock();
  await setFiles("repo-cf", ["docs/resize.md", "README.md"]);
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** cmd+n, then the first project row: the code-foundry composer. */
async function compose(page: Page): Promise<void> {
  await composeProject(page);
}

const value = (page: Page) => page.getByTestId("composer-prompt").first();
const card = (page: Page) => page.getByTestId("completion-card");
const rows = (page: Page) => card(page).getByTestId("completion-item");
const labels = (page: Page) => card(page).getByTestId("completion-label");
const headings = (page: Page) => card(page).getByTestId("completion-group");
const tags = (page: Page) => page.getByTestId("prompt-tag");
const tip = (page: Page) => page.getByTestId("prompt-tag-tooltip").locator("p");

const RESIZE = "[Fix resize race](cf-thread://s-3)";

test("@res: a Threads group above Files; Enter inserts the thread tag; the send projects it for the daemon", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@res");
  await expect(headings(page)).toHaveText(["Threads", "Files"]);
  await expect(labels(page)).toHaveText(["Fix resize race", "resize.md"]);
  await expect(rows(page).nth(0)).toContainText("code-foundry · Idle");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(card(page).getByRole("listbox")).toHaveAttribute("aria-label", "Threads and files");
  await shot(page, "threads-card");

  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", `${RESIZE} `);
  await expect(tags(page)).toHaveText(["Fix resize race"]);
  await expect(tags(page).nth(0)).toHaveAttribute("data-tag-kind", "thread");

  // The tooltip: the thread's project, then what it is doing.
  await tags(page).nth(0).hover();
  await expect(tip(page)).toHaveText(["code-foundry", "Idle"]);
  await shot(page, "thread-tag-tooltip");
  await page.mouse.move(0, 0);

  await page.keyboard.type("hit the same bug");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.new").length).toBe(1);
  const args = (await invocations()).at(-1)?.args;
  expect(args?.prompt).toBe('[Thread "Fix resize race" (id s-3)] hit the same bug');
  expect(args?.["composer-prompt"]).toBe(`${RESIZE} hit the same bug`);
});

test("archived and snoozed threads are not offered; at most three; the files stay below", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@spike");
  await expect(card(page).getByTestId("completion-empty")).toHaveText("No threads or files match");
  await page.keyboard.press("Escape");
  await page.keyboard.type(" @gh");
  await expect(card(page)).toHaveCount(0); // "Refactor the gh poller" is snoozed; no file either
  await page.keyboard.type(" @");
  // An empty query: the three most recently active threads, then the files.
  await expect(headings(page)).toHaveText(["Threads", "Files"]);
  await expect(rows(page).filter({ hasText: "·" })).toHaveCount(3);
  await expect(labels(page).filter({ hasText: /^(Spike a canvas sidebar|Refactor the gh poller)$/ })).toHaveCount(0);
});

test("the tag shows the thread's current name; Backspace removes it whole, undo brings it back; a pasted token becomes a tag", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.querySelector('[data-testid="composer-input"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "see [An old name](cf-thread://s-3) ");
  await expect(tags(page)).toHaveText(["Fix resize race"]);
  await expect(value(page)).toHaveAttribute("data-value", "see [An old name](cf-thread://s-3) ");
  await page.waitForTimeout(600); // ProseMirror groups edits within 500 ms into one undo step
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(tags(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", "see ");
  await page.keyboard.press("Meta+z");
  await expect(tags(page)).toHaveText(["Fix resize race"]);

  // A thread that is gone keeps the label it was inserted with.
  await page.keyboard.press("End");
  await page.keyboard.type("and ");
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.querySelector('[data-testid="composer-input"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "[Removed one](cf-thread://s-gone)");
  await expect(tags(page)).toHaveText(["Fix resize race", "Removed one"]);
  await tags(page).nth(1).hover();
  await expect(tip(page)).toHaveText(["Thread not found"]);
});

test("a thread's composer leaves itself out; the sent bubble draws the tag with its tooltip", async ({ page }) => {
  await mockPost("thread?state=idle"); // s-r1 "Fix stale PR badge" in code-foundry
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.type("@fix");
  await expect(card(page)).toBeVisible();
  await expect(labels(page).filter({ hasText: "Fix stale PR badge" })).toHaveCount(0);
  await expect(labels(page).first()).toHaveText("Fix resize race");
  await page.keyboard.press("Enter");
  await page.keyboard.type("has the same race");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args.text ?? "").toBe('[Thread "Fix resize race" (id s-3)] has the same race');
  const send = (await invocations()).find((i) => i.name === "thread.send");
  expect(send?.args["composer-text"]).toBe(`${RESIZE} has the same race`);
  const bubble = page.getByTestId("thread-user").last();
  await expect(bubble).toContainText("has the same race");
  const chip = bubble.locator('[data-tag-kind="thread"]');
  await expect(chip).toHaveText("Fix resize race");
  await expect(chip).toHaveAttribute("data-thread", "s-3");
  // The reply streams in under the bubble first (the timeline moves while it does).
  await expect(page.locator('[data-testid="thread-text"]').last()).toContainText("Got it");
  // The timeline settles after the turn (it folds and keeps to the bottom): hover until the tooltip shows.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await chip.hover();
    await expect(openTooltip(page)).toHaveText(/^code-foundry\s*Idle$/, { timeout: 1500 });
  }).toPass();
  await shot(page, "thread-bubble");
});
