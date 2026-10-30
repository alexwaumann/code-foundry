import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * The first-run welcome page (docs/notes/welcome-page.md): the real page from the pages
 * skill, at the path the daemon places it, opened in the welcome thread's side panel as
 * view.panel.page does. Its four steps render, a step-1 bubble sends its sentence to the
 * thread, Add a project opens the dialog, the board reads the thread's child's state, and
 * the tab reloads when the file is rewritten (a page outside every project).
 */

const PAGE = "/Users/dev/.code-foundry/pages/welcome.html";
const THREAD = "s-welcome";
const DEMO = "s-welcome-demo";
const inner = (page: Page) => page.frameLocator('[data-testid="file-html-frame"]');

/** Runs a command inside the welcome thread, as its CLI would. */
async function inThread(name: string, args: Record<string, string>): Promise<void> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, context: { activeThreadId: THREAD } }),
  });
  expect(res.ok).toBe(true);
}

test.beforeEach(async () => {
  await resetMock();
});

test("the welcome page in the panel: steps, a sent bubble, Add a project, the board, a reload on write", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mockPost("welcome");
  await openApp(page);
  await row(page, `s:${THREAD}`).click();
  await inThread("view.panel.page", { path: PAGE, title: "Welcome" });
  await expect(page.getByTestId("panel-tabs").getByRole("tab")).toHaveText(["Welcome"]);

  const doc = inner(page);
  await expect(doc.getByRole("heading", { level: 2 })).toHaveText(["Say something to it", "Point it at your work", "Put several agents on it", "Make it yours"]);

  // A step-1 bubble sends its sentence to this thread.
  const sentence = "remember that I like short answers, and ask before you assume";
  await doc.getByRole("button", { name: new RegExp(sentence) }).click();
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args).toMatchObject({ text: sentence });
  await expect(doc.getByText("Sent:")).toBeVisible();

  // No project yet: Add a project opens the dialog.
  await doc.getByRole("button", { name: "Add a project…" }).click();
  await expect(page.getByTestId("add-project-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("add-project-dialog")).toHaveCount(0);

  // The board lists the thread's child and reads its state; finished is done, not a request.
  const demo = doc.getByRole("button", { name: /What this project is/ });
  await expect(demo).toContainText("Working");
  await mockPost(`thread/status?id=${DEMO}&status=attention&reason=finished`);
  await expect(demo).toContainText("Finished");
  await mockPost(`thread/status?id=${DEMO}&status=attention&reason=${encodeURIComponent("permission: Bash")}`);
  await expect(demo).toContainText("Needs permission");

  // Outside every project, the tab still follows a write of the file.
  await mockPost(`fs/write?path=${encodeURIComponent(PAGE)}&text=${encodeURIComponent('<!doctype html><h1 id="new">Rewritten</h1>')}`);
  await expect(doc.locator("#new")).toHaveText("Rewritten");
});
