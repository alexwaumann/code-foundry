import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * The File and Diff panel tabs (docs/notes/file-viewer-3-tabs.md) against the mock
 * daemon's files (mock/files.ts), for what only a browser shows: @pierre/diffs drawing a
 * diff and marking a line (scrolled into view), the HTML sandbox's interactive page,
 * images decoding, pdf.js drawing a PDF's pages. Their headers, states and choices are
 * src/components/files/*.test.tsx's. SHOTS=<dir> saves screenshots.
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const activeTab = (page: Page) => page.getByTestId("panel-tabs").locator('[role="tab"][aria-selected="true"]');
const diff = (page: Page) => page.getByTestId("diff-tab");
const file = (page: Page) => page.getByTestId("file-tab");

/** Selects a thread and opens its own Changes tab in its panel (the card's Changes row). */
async function worktreeTab(page: Page, threadId: string): Promise<void> {
  await row(page, `s:${threadId}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await openThreadChanges(page);
  await expect(panel(page)).toHaveAttribute("data-panel-key", `thread:${threadId}`);
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
}

/** Opens a File tab in the current panel the way path chips will (stores/filePanel.ts). */
async function openFile(page: Page, path: string, line?: number): Promise<void> {
  const target = JSON.stringify({ project: "repo-cf", base: CF, path, ...(line ? { line } : {}) });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
}

const changeRow = (page: Page, path: string) => page.locator(`[data-nav-key="f:${path}"]`);

test.beforeEach(async () => {
  await resetMock();
});

// The Diff tab's header, Unified ↔ Split, the scope switch and No changes: src/components/files/DiffTab.test.tsx;
// a row opening its tab on the row's scope: src/components/changes/ChangesView.test.tsx; the same row
// again re-activating its tab and resetting the scope: src/stores/filePanel.test.ts. Left here: the
// library drawing the diff (its shadow root).
test("a Changes row opens its Diff tab, and @pierre/diffs draws its lines", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");
  await changeRow(page, "README.md").click();
  await expect(tabs(page)).toHaveText(["Changes", "README.md"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
  // The library renders into its shadow root; CSS locators pierce it.
  await expect(diff(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
});

// Committed changes opening on the branch (a rename, a deletion, a binary): src/components/changes/ChangesView.test.tsx
// (scope branch, the old path) and src/components/files/DiffTab.test.tsx (R, D with nothing to open, Binary file); the
// tab titles are src/surfaces/files.test.ts's. Deleted lines are drawn by the same library as the added ones above.

// Open file to the File tab: DiffTab.test.tsx; Rendered ↔ Source, the meta, the wrap toggle and the remembered mode:
// src/components/files/FileTab.test.tsx; the File and Diff entries and their letters: src/surfaces/files.test.ts and
// src/components/panel/SidePanel.test.tsx. Left here: a local image decoding, and the library marking the line.
test("Open file goes to the File tab: a markdown image decodes; Source marks the first change in the code view", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");
  await changeRow(page, "README.md").click();
  await diff(page).getByTestId("diff-open-file").click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "files");
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
