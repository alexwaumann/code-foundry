import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, resetMock } from "./fixtures";
import { openThread } from "./shell";

/**
 * The File tab's previews (docs/notes/file-previews-1-registry.md). Which kind a file is,
 * its modes, its meta and its header actions are vitest's (src/components/files/previews/,
 * FileTab.test.tsx); this file keeps only the SHOTS-gated screenshots of the header and the
 * previews in a real browser. SHOTS=<dir> saves them.
 */

const file = (page: Page) => page.getByTestId("file-tab");

/** Opens a File tab beside the thread the way a path chip does (stores/filePanel.ts). */
async function openFile(page: Page, path: string): Promise<void> {
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/${path}`);
}

test.beforeEach(async () => {
  await resetMock();
});

const shots = process.env.SHOTS;

test("file preview screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp(page);
  await openThread(page, "s-1");
  const shot = async (name: string, header = false) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      const target = header ? file(page).getByTestId("file-header") : page.getByTestId("shell-pane").filter({ has: file(page) });
      await target.screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openFile(page, "src/app.ts");
  await expect(file(page).getByTestId("file-meta")).toContainText("lines");
  await shot("header-ts", true);
  const copy = file(page).getByTestId("file-copy-contents");
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied");
  await shot("header-ts-copied", true);
  await openFile(page, "README.md");
  await expect(file(page).getByTestId("file-markdown")).toBeVisible();
  await shot("header-md", true);
  await openFile(page, "docs/logo.svg");
  await expect(file(page).getByTestId("file-image").locator("img")).toBeVisible();
  await expect(file(page).getByTestId("file-meta")).toContainText("×");
  await shot("svg-image");
  await file(page).getByTestId("file-mode-source").click();
  await expect(file(page).getByTestId("file-meta")).toContainText("lines");
  await shot("svg-source");
});
