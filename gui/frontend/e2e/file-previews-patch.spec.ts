import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, resetMock, threadsOpenAsTabs } from "./fixtures";
import { openThread } from "./shell";

/**
 * The patch preview (docs/notes/file-previews-5-patch.md). Parsing, the rows, folding, the
 * notes and the header are vitest's (previews/patch.test.ts, PatchBody.test.tsx, FileTab.test.tsx);
 * this file keeps what needs the library's CodeView in a real browser: a long patch mounts
 * only the diffs in view. And the SHOTS-gated screenshots (SHOTS=<dir> saves them).
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
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
});

test("a 1 MiB patch mounts only the files in view, and reaches its last", async ({ page }) => {
  await openApp(page);
  await openThread(page, "s-1");
  await openFile(page, "docs/patches/big.patch");
  const rows = file(page).getByTestId("file-patch-file");
  await expect(rows.first()).toBeVisible();
  await expect(file(page).getByTestId("file-meta")).toContainText(/^[\d,]+ files · /);
  expect(await rows.count()).toBeLessThan(20);
  const box = file(page).getByTestId("file-patch").locator(":scope > div").first();
  await box.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // The read stops at 1 MiB: the last section is the one it cut, marked as not parsed whole.
  const last = rows.last();
  await expect(last).toHaveAttribute("data-path", /module-\d+\.ts$/);
  await expect(last.getByTestId("file-patch-problem")).toBeVisible();
  expect(await rows.count()).toBeLessThan(20);
});

const shots = process.env.SHOTS;

test("patch preview screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1200, height: 820 });
  await openApp(page);
  await openThread(page, "s-1");
  const shot = async (name: string) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page
        .getByTestId("shell-pane")
        .filter({ has: file(page) })
        .screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openFile(page, "docs/patches/0001-fix-layout-ops.patch");
  await expect(file(page).getByTestId("file-patch-commit-head")).toBeVisible();
  await shot("patch-format-patch");
  await file(page).getByTestId("file-patch-style-split").click();
  await shot("patch-split");
  await file(page).getByTestId("file-patch-style-unified").click();
  await openFile(page, "docs/patches/series.patch");
  await expect(file(page).getByTestId("file-patch-commit").first()).toBeVisible();
  await shot("patch-mailbox");
  await openFile(page, "docs/patches/config.diff");
  await expect(file(page).getByTestId("file-patch-file")).toBeVisible();
  await shot("patch-plain-diff");
  await openFile(page, "docs/patches/rename-binary.diff");
  await expect(file(page).getByTestId("file-patch-note").first()).toBeVisible();
  await shot("patch-rename-binary");
  await openFile(page, "docs/patches/broken.diff");
  await expect(file(page).getByTestId("file-patch-problems")).toBeVisible();
  await file(page).getByTestId("file-patch-file").first().click();
  await expect(file(page).getByTestId("file-patch-problem")).toBeVisible();
  await shot("patch-malformed");
  await openFile(page, "docs/patches/notes.diff");
  await expect(file(page).getByTestId("file-patch-none")).toBeVisible();
  await shot("patch-not-a-diff");
});
