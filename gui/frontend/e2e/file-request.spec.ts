import { expect, test, type Locator, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, mockPost, mockUrl, openApp, openThreadChanges, resetMock, row } from "./fixtures";

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
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, context: { activeThreadId: "s-1" } }),
  });
  expect(res.ok).toBe(true);
}

async function inThread(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
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
  await page.keyboard.press("Meta+f");
  const find = file(page).locator("[data-search-panel] input").first();
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
