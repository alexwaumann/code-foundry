import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * view.panel.file, view.panel.diff and view.panel.pr from inside a thread
 * (docs/notes/control-5-fixes.md): the model in s-1 opens a file, a changed file's diff and
 * a pull request in its own side panel while the user looks at s-2. The window does not
 * move; the tabs are there when the user opens s-1. SHOTS=<dir> saves screenshots.
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");

/** Runs a command as the CLI inside thread s-1 would (no active view). */
async function inS1(name: string, args: Record<string, string>): Promise<string> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, context: { activeThreadId: "s-1" } }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { message?: string }).message ?? "";
}

const shots = process.env.SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${shots}/${name}-${scheme}-${test.info().project.name}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

test.beforeEach(async () => {
  await resetMock();
});

test("a thread's model opens a file, a diff and a pull request in its own panel; the window stays on the user's thread", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");

  expect(await inS1("view.panel.file", { path: `${CF}/README.md`, line: "3" })).toMatch(/^windows=1 thread=s-1$/);
  expect(await inS1("view.panel.diff", { path: `${CF}/README.md` })).toMatch(/^windows=1 thread=s-1$/);
  expect(await inS1("view.panel.pr", { number: "145" })).toMatch(/^windows=1 thread=s-1$/);

  // The user's view did not move, and s-2's panel stayed shut.
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await expect(panel(page)).toHaveCount(0);

  // In s-1 the three tabs wait, the last one active.
  await row(page, "s:s-1").click();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await expect(tabs(page)).toHaveText(["README.md", "README.md", "#145"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
  await expect(page.getByTestId("pr-title")).toHaveText("fix(terminal): resize race between attach and first output");
  await shot(page, "thread-panel-pr");

  await tabs(page).nth(0).click();
  await expect(page.getByTestId("file-tab")).toHaveAttribute("data-path", `${CF}/README.md`);
  await shot(page, "thread-panel-file");

  await tabs(page).nth(1).click();
  await expect(page.getByTestId("diff-tab")).toHaveAttribute("data-scope", "working");
  await expect(page.getByTestId("diff-tab").locator('[data-line-type="change-addition"]').first()).toBeVisible();
  await shot(page, "thread-panel-diff");
});
