import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, openThreadChanges, resetMock } from "./fixtures";
import { openThread } from "./shell";
import { activeOfKind, paneWith, stripTabs } from "./shell-surfaces";

/**
 * The File and Diff tabs (docs/notes/file-viewer-3-tabs.md) against the mock
 * daemon's files (mock/files.ts), for what only a browser shows: @pierre/diffs drawing a
 * diff and marking a line (scrolled into view), the HTML sandbox's interactive page,
 * images decoding, pdf.js drawing a PDF's pages. Their headers, states and choices are
 * src/components/files/*.test.tsx's. SHOTS=<dir> saves screenshots.
 */

/** The pane of the thread's linked tabs, beside its own. */
const panel = (page: Page) => paneWith(page, "diff");
const tabs = (page: Page) => stripTabs(panel(page));
const activeTab = (page: Page) => panel(page).getByTestId("shell-tab-strip").locator('[role="tab"][aria-selected="true"]');
const diff = (page: Page) => page.getByTestId("diff-file");
const file = (page: Page) => page.getByTestId("file-tab");

/** Opens a thread's tab and its own Diff tab, linked to it (the card's Changes row). */
async function worktreeTab(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId);
  await openThreadChanges(page);
  await expect(panel(page).locator(`[data-testid="shell-tab"][data-kind="diff"]`)).toHaveCount(1);
  await expect(page.getByTestId("diff-file-list")).toBeVisible();
}

/**
 * Opens a File tab linked to the current thread the way path chips do (stores/filePanel.ts):
 * beside its diff, shown. A chip is in the conversation, so the thread's pane has the focus.
 */
async function openFile(page: Page, path: string, line?: number): Promise<void> {
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path, ...(line ? { line } : {}) });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
}

const changeRow = (page: Page, path: string) => page.locator(`[data-nav-key="f:${path}"]`);

test.beforeEach(async () => {
  await resetMock();
});

// The list, the sources, the file states and Open file: src/components/diff/DiffView.test.tsx. Left here: the
// library drawing the diff (its shadow root).
test("a row shows its file in the tab, and @pierre/diffs draws its lines", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");
  await changeRow(page, "README.md").click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(activeOfKind(page, "diff")).toHaveCount(1);
  await expect(diff(page)).toHaveAttribute("data-path", "README.md");
  // The library renders into its shadow root; CSS locators pierce it.
  await expect(diff(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
});

// Open file to the File tab: DiffView.test.tsx; Rendered ↔ Source, the meta, the wrap toggle and the remembered mode:
// src/components/files/FileTab.test.tsx; the File and Diff entries: src/surfaces/files.test.ts. Left here: a local image decoding, and the library marking the line.
test("Open file goes to the File tab: a markdown image decodes; Source marks the first change in the code view", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");
  await changeRow(page, "README.md").click();
  await diff(page).getByTestId("diff-open-file").click();
  await expect(activeOfKind(page, "file")).toHaveCount(1);
  await expect(file(page).getByTestId("file-markdown").getByTestId("md-local-image")).toHaveJSProperty("naturalWidth", 2);
  await file(page).getByTestId("file-mode-source").click();
  await expect(file(page).getByTestId("file-code").locator('[data-line="3"][data-selected-line]').first()).toBeVisible();
});

// The meta lines, the same tab for another line, the HTML frame's attributes and footer, the binary, folder and
// truncated notices: src/components/files/FileTab.test.tsx and HtmlPreview.test.tsx. Left here: the line scrolled
// into view, the interactive sandboxed page, and an image decoding.
test("a TypeScript file at a line scrolls to it; the HTML sandbox runs its page; an image decodes", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");

  await openFile(page, "src/app.ts", 43);
  await expect(activeTab(page)).toHaveText("app.ts");
  const marked = file(page).getByTestId("file-code").locator('[data-line="43"][data-selected-line]').first();
  await expect(marked).toBeVisible();
  await expect(marked).toBeInViewport();

  await openFile(page, "docs/preview.html");
  await expect(file(page)).toHaveAttribute("data-mode", "rendered");
  // Served by the daemon at a granted URL (with the frame's nonce: docs/notes/bridge-fix-frames.md).
  await expect(file(page).getByTestId("file-html-frame")).toHaveAttribute("src", /\/preview\/mock-preview-\d+\/docs\/preview\.html#cf=[0-9a-f]{32}$/);
  // The page is interactive: its script ran, a relative image loaded, a button's handler fires,
  // and an in-page anchor stays in the page (a srcdoc frame navigated into the app's blank shell).
  const inner = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(inner.locator("#title")).toHaveText("script ran");
  await expect(inner.locator("#local")).toHaveJSProperty("naturalWidth", 2);
  await inner.locator("#count").click();
  await inner.locator("#count").click();
  await expect(inner.locator("#count")).toHaveText("2 clicks");
  await inner.locator("#anchor").click();
  await expect(inner.locator("#count")).toHaveText("2 clicks");
  // A relative link to a sibling file loads it from the same grant.
  await inner.locator("#sibling").click();
  await expect(inner.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await expect(inner.locator("#count")).toHaveCount(0);
  await file(page).getByTestId("file-mode-source").click();
  await expect(file(page).getByTestId("file-code")).toBeVisible();

  await openFile(page, "docs/logo.png");
  await expect(file(page).getByTestId("file-image").locator("img")).toHaveJSProperty("naturalWidth", 2);
});

// The PDF and image meta, no mode or wrap for a PDF, and the too-large states: src/components/files/FileTab.test.tsx.
// Left here: pdf.js counting and drawing the pages, the page column filling the tab and scrolling, and a 1.5 MB
// image coming back whole (the tab's 32 MiB read through the daemon) and decoding.
test("a PDF shows its pages; a 1.5 MB image comes back whole", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");

  // docs/spec.pdf is 1.2 MB: whole only because the tab asks for 32 MiB (pdf.js cannot open a cut PDF).
  await openFile(page, "docs/spec.pdf");
  await expect(activeTab(page)).toHaveText("spec.pdf");
  const pdf = file(page).getByTestId("file-pdf");
  await expect(pdf.getByTestId("pdf-pages")).toHaveAttribute("data-pages", "3");
  await expect(pdf.getByTestId("pdf-page")).toHaveCount(3);
  await expect(pdf.locator('[data-testid="pdf-page"][data-page="1"]')).toHaveAttribute("data-rendered", "true");
  const canvas = pdf.locator('[data-testid="pdf-page"][data-page="1"] canvas');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
  // The column fills the tab body and scrolls inside it.
  const [tab, column] = await Promise.all([file(page).boundingBox(), pdf.getByTestId("pdf-pages").boundingBox()]);
  expect(Math.abs((column?.y ?? 0) + (column?.height ?? 0) - ((tab?.y ?? 0) + (tab?.height ?? 0)))).toBeLessThanOrEqual(1);
  expect(await pdf.getByTestId("pdf-pages").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await openFile(page, "docs/photo.png");
  await expect(file(page).getByTestId("file-image").locator("img")).toHaveJSProperty("naturalWidth", 2);
});

// A missing file, Retry, the re-read when the worktree changes and Refresh: src/components/files/FileTab.test.tsx.

// A path missing at the checkout opening the one file that ends with it, two candidates staying not found: src/components/files/FileTab.test.tsx ("a path not found at the checkout opens the one file…", "a path in two places…"); the line marked is the tests above.

// ---- screenshots (SHOTS=<dir>) ------------------------------------------------------

const shots = process.env.SHOTS;

test("file and diff tab screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp(page);
  await worktreeTab(page, "s-1");
  const shot = async (name: string) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await panel(page).screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await changeRow(page, "README.md").hover();
  await shot("changes-hover");
  await changeRow(page, "README.md").click();
  await expect(diff(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
  await shot("diff-unified");
  await diff(page).getByTestId("diff-open-file").click();
  await expect(file(page).getByTestId("file-markdown")).toBeVisible();
  await shot("md-rendered");
  await file(page).getByTestId("file-mode-source").click();
  await shot("md-source");
  await file(page).getByTestId("file-mode-rendered").click();
  await openFile(page, "src/app.ts", 43);
  await shot("ts-line");
  await openFile(page, "docs/preview.html");
  await shot("html");
});
