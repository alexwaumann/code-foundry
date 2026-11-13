import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, invokeAs, mockPost, mockUrl, openApp, openThreadChanges, resetMock, row } from "./fixtures";
import { paneWith, stripTabs, threadTabOpen } from "./shell-surfaces";

/**
 * A thread asking the user to edit a file, and the keyboard around it
 * (docs/notes/file-edit-3-agent.md), for what only a browser shows: a band arriving while the
 * user types elsewhere, the caret and the mark in the library's shadow root, and the find
 * field and palette handing the keyboard back. What the band says, what is sent and when,
 * and every state are src/components/files/FileRequestBand.test.tsx's and
 * src/stores/fileRequest.test.ts's.
 */

const file = (page: Page) => page.getByTestId("file-tab");
const band = (page: Page) => page.getByTestId("file-request");
/** The library's contenteditable; CSS locators pierce its shadow root. */
const editor = (page: Page): Locator => file(page).locator('[data-content][contenteditable="true"]');
const line = (page: Page, n: number) => editor(page).locator(`[data-line="${String(n)}"]`);
const composer = (page: Page) => page.getByTestId("thread-composer").getByTestId("composer-input");

async function disk(path: string): Promise<string | null> {
  const res = await fetch(`${mockUrl}/__mock/fs/text?path=${encodeURIComponent(path)}`);
  return ((await res.json()) as { text: string | null }).text;
}

async function writeDisk(path: string, text: string): Promise<void> {
  await mockPost(`fs/write?path=${encodeURIComponent(path)}&text=${encodeURIComponent(text)}`);
}

/** The CLI in thread s-1 running a verb. */
async function fromThread(name: string, args: Record<string, string>): Promise<void> {
  expect((await invokeAs("s-1", name, args)).ok).toBe(true);
}

async function inThread(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await threadTabOpen("s-1");
}

test.beforeEach(async () => {
  await resetMock();
});

test("a request arriving while the user types in the composer takes nothing from it", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\nB=2\n");
  await inThread(page);
  await composer(page).click();
  await page.keyboard.type("half a ");

  await fromThread("view.panel.file", { path: env, edit: "true", line: "2", note: "Put the key on line 2" });

  await expect(band(page)).toContainText("Put the key on line 2");
  await expect(editor(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("message");
  await expect(composer(page)).toContainText("half a message");
  await expect(line(page, 2)).toHaveText("B=2");
  await expect(line(page, 1)).toHaveText("A=1");
  expect(await disk(env)).toBe("A=1\nB=2\n");
});

test("a note cannot take the band over: the buttons and the editor stay on screen", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\n");
  await inThread(page);
  // The mock passes a note as it came, so this is the band's own defence.
  const note = `Code Foundry${"\n".repeat(60)}Session expired. ${"Paste your token on line 1. ".repeat(40)}`;
  await fromThread("view.panel.file", { path: env, edit: "true", note });
  await expect(editor(page)).toBeVisible();
  await expect(page.getByTestId("file-request-dismiss")).toBeInViewport();
  await expect(page.getByTestId("file-request-tell")).toBeInViewport();
  await expect(line(page, 1)).toBeInViewport();
  expect((await band(page).boundingBox())?.height).toBeLessThan(220);
});

test("a link's target cannot take the band over either, nor a note push it out of sight", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\n");
  await mockPost(`fs/link?path=${encodeURIComponent(env)}&real=${encodeURIComponent(`/Users/dev/${"d/".repeat(480)}\u202edrop.txt`)}`);
  await page.setViewportSize({ width: 1280, height: 500 });
  await inThread(page);
  await fromThread("view.panel.file", { path: env, edit: "true", note: "Paste your token here. ".repeat(21) });
  await expect(editor(page)).toBeVisible();
  await expect(page.getByTestId("file-request-tell")).toBeInViewport();
  await expect(page.getByTestId("file-request-fact").first()).toBeInViewport();
  expect((await band(page).boundingBox())?.height).toBeLessThan(220);
});

test("a request for another file leaves the document under the user's fingers", async ({ page }) => {
  const a = `${CF}/a.env`;
  const b = `${CF}/b.env`;
  await writeDisk(a, "A=\n");
  await writeDisk(b, "B=\n");
  await inThread(page);
  await fromThread("view.panel.file", { path: a, edit: "true" });
  await expect(editor(page)).toBeVisible();
  await line(page, 1).click();
  await page.keyboard.press("End");
  await page.keyboard.type("1");

  await fromThread("view.panel.file", { path: b, edit: "true", note: "Fill in B" });

  // Both in the thread's pane of files, a.env still the one shown.
  await expect(stripTabs(paneWith(page, "file"))).toHaveText(["a.env", "b.env"]);
  await page.keyboard.type("2");
  await expect(line(page, 1)).toHaveText("A=12");
  await expect(file(page)).toHaveAttribute("data-path", a);
});

test("--line marks and scrolls to the line in the editor, as in the viewer", async ({ page }) => {
  const long = `${CF}/long.env`;
  await writeDisk(long, Array.from({ length: 200 }, (_, i) => `K${String(i + 1)}=v`).join("\n"));
  await inThread(page);
  await fromThread("view.panel.file", { path: long, edit: "true", line: "150" });
  await expect(editor(page)).toBeVisible();
  await expect(line(page, 150)).toBeInViewport();
  await expect(line(page, 150)).toHaveAttribute("data-selected-line", /.*/);
});

test("--focus puts the caret at the end of the line", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\nB=\nC=3\n");
  await inThread(page);
  await fromThread("view.panel.file", { path: env, edit: "true", line: "2", focus: "true" });
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("two");
  await expect(line(page, 2)).toHaveText("B=two");
  await page.keyboard.press("Meta+s");
  await expect(band(page)).toHaveCount(0);
  await expect.poll(() => disk(env)).toBe("A=1\nB=two\nC=3\n");
});

test("with find open, an outside change leaves the keyboard in the find field and out of the file", async ({ page }) => {
  const notes = `${CF}/notes.txt`;
  await writeDisk(notes, "mine\n");
  await inThread(page);
  await openThreadChanges(page);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: "notes.txt", edit: true })}))`);
  await expect(editor(page)).toBeVisible();
  await line(page, 1).click();
  // The tab's find bar (e2e/file-find.spec.ts), outside the editor that the re-read remounts.
  await page.keyboard.press("Meta+f");
  const find = page.getByTestId("file-find-input");
  await expect(find).toBeFocused();

  await writeDisk(notes, "theirs\n");
  await file(page).getByTestId("file-refresh").dispatchEvent("click");
  await expect.poll(() => disk(notes)).toBe("theirs\n");
  await page.waitForTimeout(500);

  await expect(find).toBeFocused();
  await page.keyboard.type("zz");
  await expect(find).toHaveValue("zz");
  await expect(page.getByTestId("file-edit-status")).toHaveText("Editing");

  // With the field gone, the document is the file's.
  await page.keyboard.press("Escape");
  await expect(line(page, 1)).toHaveText("theirs");
});

test("Save File from the palette puts the keyboard back in the editor", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\n");
  await inThread(page);
  await openThreadChanges(page);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: ".env", edit: true })}))`);
  await expect(editor(page)).toBeVisible();
  await line(page, 1).click();
  await page.keyboard.press("End");
  await page.keyboard.type("0");
  await page.keyboard.press("Meta+k");
  const palette = page.locator('[data-region="palette"]');
  await expect(palette).toBeVisible();
  await page.keyboard.type("Save File");
  await palette.locator('[data-command="file.save"]').click();
  await expect(palette).toHaveCount(0);
  await expect.poll(() => disk(env)).toBe("A=10\n");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("0");
  await expect(line(page, 1)).toHaveText("A=100");
});
