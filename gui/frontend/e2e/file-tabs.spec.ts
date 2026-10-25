import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * The File and Diff panel tabs (docs/notes/file-viewer-3-tabs.md) against the mock
 * daemon's files (mock/files.ts): a Changes row opens its Diff tab, Unified ↔ Split and the
 * scope switch, Open file to the File tab, Rendered ↔ Source, a TypeScript file at a line,
 * the HTML sandbox, an image, a PDF's pages, images and PDFs too large to show, a binary,
 * a folder, a missing file with Retry, a truncated read, and a re-read when the worktree
 * changes. SHOTS=<dir> saves screenshots.
 */

const FEAT = `${CF}.worktrees/feat-sidebar`;
const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const activeTab = (page: Page) => page.getByTestId("panel-tabs").locator('[role="tab"][aria-selected="true"]');
const diff = (page: Page) => page.getByTestId("diff-tab");
const file = (page: Page) => page.getByTestId("file-tab");

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/fs/calls`);
  return (await res.json()) as string[];
}

/** Selects a thread and opens its own worktree's tab in its panel (T). */
async function worktreeTab(page: Page, threadId: string): Promise<void> {
  await row(page, `s:${threadId}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveAttribute("data-panel-key", `thread:${threadId}`);
  await page.keyboard.press("t");
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
}

/** Opens a File tab in the current panel the way path chips will (stores/filePanel.ts). */
async function openFile(page: Page, path: string, line?: number): Promise<void> {
  const target = JSON.stringify({ project: "repo-cf", base: CF, path, ...(line ? { line } : {}) });
  await page.evaluate(`import("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
}

const changeRow = (page: Page, path: string) => page.locator(`[data-nav-key="f:${path}"]`);

test.beforeEach(async () => {
  await resetMock();
});

test("a Changes row opens its Diff tab on the working tree; Unified ↔ Split, the scope switch, and the same row again", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");

  await changeRow(page, "README.md").click();
  await expect(tabs(page)).toHaveText(["code-foundry", "README.md"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
  await expect(diff(page)).toHaveAttribute("data-scope", "working");
  await expect(diff(page).getByTestId("file-header-name")).toHaveText("README.md");
  await expect(diff(page).getByTestId("diff-status")).toHaveText("M");
  await expect(diff(page).getByTestId("diff-meta")).toContainText("vs main");
  await expect(diff(page).getByTestId("diff-meta")).toContainText("+");
  // The library renders into its shadow root; CSS locators pierce it.
  await expect(diff(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();

  // Unified ↔ Split: the codeView store's style, for every diff.
  await expect(diff(page)).toHaveAttribute("data-style", "unified");
  await diff(page).getByTestId("diff-style-split").click();
  await expect(diff(page)).toHaveAttribute("data-style", "split");
  await expect(diff(page).getByTestId("diff-style-split")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("code-foundry.codeView"))).toContain('"diffStyle":"split"');
  await diff(page).getByTestId("diff-style-unified").click();
  await expect(diff(page)).toHaveAttribute("data-style", "unified");

  // Branch: README.md only changed in the working tree, so nothing is committed.
  await diff(page).getByTestId("diff-scope-branch").click();
  await expect(diff(page)).toHaveAttribute("data-scope", "branch");
  await expect(diff(page).getByTestId("diff-none")).toContainText("No changes");
  expect(await calls()).toContain(`diff ${CF} README.md branch`);
  await diff(page).getByTestId("diff-scope-working").click();
  await expect(diff(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();

  // The same row again activates the tab rather than adding one, and resets its scope.
  await diff(page).getByTestId("diff-scope-branch").click();
  await tabs(page).filter({ hasText: "code-foundry" }).click();
  await changeRow(page, "README.md").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(activeTab(page)).toHaveText("README.md");
  await expect(diff(page)).toHaveAttribute("data-scope", "working");

  // Enter on a row works too.
  await tabs(page).filter({ hasText: "code-foundry" }).click();
  await changeRow(page, "notes/plan.md").click();
  await expect(activeTab(page)).toHaveText("plan.md");
  await expect(diff(page).getByTestId("diff-status")).toHaveText("A");
});

test("committed changes open on the branch: a rename, a deletion and a binary", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-4");
  await expect(page.getByTestId("worktree-surface")).toHaveAttribute("data-path", FEAT);

  await changeRow(page, "docs/notes/sidebar.md").click();
  await expect(diff(page)).toHaveAttribute("data-scope", "branch");
  await expect(diff(page).getByTestId("diff-status")).toHaveText("R");

  await tabs(page).first().click();
  await changeRow(page, "gui/frontend/src/lib/old-tree.ts").click();
  await expect(diff(page).getByTestId("diff-status")).toHaveText("D");
  await expect(diff(page).locator('[data-line-type="change-deletion"]').first()).toBeVisible();
  // A deleted file has nothing to open.
  await expect(diff(page).getByTestId("diff-open-file")).toHaveCount(0);

  await tabs(page).first().click();
  await changeRow(page, "assets/icon.png").click();
  await expect(diff(page).getByTestId("diff-binary")).toContainText("Binary file");
  await expect(tabs(page)).toHaveText(["code-foundry · feat/sidebar", "sidebar.md", "old-tree.ts", "icon.png"]);
});

test("Open file goes to the File tab; markdown Rendered ↔ Source is remembered; the letters bring tabs back", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");
  await changeRow(page, "README.md").click();
  await diff(page).getByTestId("diff-open-file").click();
  await expect(activeTab(page)).toHaveText("README.md");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "files");
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/README.md`);

  // Rendered by default: headings, a table, a local image read from disk.
  await expect(file(page)).toHaveAttribute("data-mode", "rendered");
  const md = file(page).getByTestId("file-markdown");
  await expect(md.getByRole("heading", { level: 1 })).toHaveText("code-foundry");
  await expect(md.locator("table")).toBeVisible();
  await expect(md.getByTestId("md-local-image")).toHaveJSProperty("naturalWidth", 2);
  await expect(file(page).getByTestId("file-meta")).toContainText("saved");
  await expect(file(page).getByTestId("file-wrap")).toHaveCount(0);

  // Source: the code view at the first change (line 3), with the wrap toggle.
  await file(page).getByTestId("file-mode-source").click();
  await expect(file(page)).toHaveAttribute("data-mode", "source");
  await expect(file(page).getByTestId("file-code").locator('[data-line="3"][data-selected-line]').first()).toBeVisible();
  await expect(file(page).getByTestId("file-meta")).toContainText("lines");
  await expect(file(page).getByTestId("file-meta")).toContainText("Markdown");
  await file(page).getByTestId("file-wrap").click();
  await expect(file(page).getByTestId("file-wrap")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("code-foundry.codeView"))).toContain('"markdown":"source"');

  // Another markdown file opens as source now; Rendered again for both.
  await openFile(page, "notes/plan.md");
  await expect(file(page)).toHaveAttribute("data-mode", "source");
  await file(page).getByTestId("file-mode-rendered").click();
  await expect(file(page).getByTestId("file-markdown")).toBeVisible();

  // The list's File and Diff entries are live now that the panel has such tabs.
  await page.getByTestId("panel-new-tab").click();
  const empty = page.getByTestId("panel-empty");
  await expect(empty.locator('[data-surface="files"]')).toBeEnabled();
  await expect(empty.locator('[data-surface="diff"]')).toBeEnabled();
  await page.keyboard.press("d");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "diff");
});

test("a TypeScript file at a line, the HTML sandbox, an image, a binary, a folder, a truncated read", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");

  await openFile(page, "src/app.ts", 43);
  await expect(activeTab(page)).toHaveText("app.ts");
  await expect(file(page).getByTestId("file-header-dir")).toContainText("src/");
  await expect(file(page).getByTestId("file-meta")).toHaveText("80 lines · 2 KB · TypeScript");
  const marked = file(page).getByTestId("file-code").locator('[data-line="43"][data-selected-line]').first();
  await expect(marked).toBeVisible();
  await expect(marked).toBeInViewport();
  // The same file at another line: the same tab, the new line.
  await openFile(page, `${CF}/src/app.ts`, 10);
  await expect(tabs(page).filter({ hasText: "app.ts" })).toHaveCount(1);
  await expect(file(page).getByTestId("file-code").locator('[data-line="10"][data-selected-line]').first()).toBeVisible();

  await openFile(page, "docs/preview.html");
  await expect(file(page)).toHaveAttribute("data-mode", "rendered");
  const frame = file(page).getByTestId("file-html-frame");
  // Served by the daemon at a granted URL (with the frame's nonce: docs/notes/bridge-fix-frames.md), in a
  // sandbox with an opaque origin (no thread showed it) and no top navigation.
  await expect(frame).toHaveAttribute("src", /\/preview\/mock-preview-\d+\/docs\/preview\.html#cf=[0-9a-f]{32}$/);
  const sandbox = (await frame.getAttribute("sandbox")) ?? "";
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
  expect(sandbox).not.toContain("allow-top-navigation");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(file(page).getByTestId("file-html-footer")).toHaveText("Sandboxed from Code Foundry · scripts and network on · loads files under ~/src/code-foundry");
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
  await expect(file(page).getByTestId("file-meta")).toHaveText("2 × 2 · 79 B · PNG");

  await openFile(page, "bin/tool");
  await expect(file(page).getByTestId("file-binary")).toContainText("Binary file · 2.3 MB");

  await openFile(page, "docs");
  await expect(file(page).getByTestId("file-folder")).toContainText("This is a folder");

  await openFile(page, "big.log");
  await expect(file(page).getByTestId("file-truncated")).toHaveText("Showing the first 1 MiB of 4.2 MB");
});

test("a PDF shows its pages; a 1.5 MB image comes back whole; an image or PDF over the read cap is too large to show", async ({ page }) => {
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
  await expect(file(page).getByTestId("file-meta")).toHaveText("3 pages · 1.2 MB · PDF");
  await expect(file(page).getByTestId("file-mode")).toHaveCount(0);
  await expect(file(page).getByTestId("file-wrap")).toHaveCount(0);
  await expect(file(page).getByTestId("file-binary")).toHaveCount(0);
  // The column fills the tab body and scrolls inside it.
  const [tab, column] = await Promise.all([file(page).boundingBox(), pdf.getByTestId("pdf-pages").boundingBox()]);
  expect(Math.abs((column?.y ?? 0) + (column?.height ?? 0) - ((tab?.y ?? 0) + (tab?.height ?? 0)))).toBeLessThanOrEqual(1);
  expect(await pdf.getByTestId("pdf-pages").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await openFile(page, "docs/photo.png");
  await expect(file(page).getByTestId("file-image").locator("img")).toHaveJSProperty("naturalWidth", 2);
  await expect(file(page).getByTestId("file-meta")).toHaveText("2 × 2 · 1.5 MB · PNG");

  await openFile(page, "docs/huge.png");
  const bigImage = file(page).getByTestId("file-image-too-large");
  await expect(bigImage).toContainText("Image · 47.7 MB · too large to show");
  await expect(bigImage.getByRole("button", { name: "Open in editor" })).toBeVisible();
  await expect(bigImage.getByRole("button", { name: "Reveal in Finder" })).toBeVisible();
  await expect(file(page).getByTestId("file-image")).toHaveCount(0);
  await expect(file(page).getByTestId("file-truncated")).toHaveCount(0);

  await openFile(page, "docs/huge.pdf");
  const bigPdf = file(page).getByTestId("file-pdf-too-large");
  await expect(bigPdf).toContainText("PDF · 47.7 MB · too large to show");
  await expect(bigPdf.getByRole("button", { name: "Open in editor" })).toBeVisible();
  await expect(bigPdf.getByRole("button", { name: "Reveal in Finder" })).toBeVisible();
  await expect(file(page).getByTestId("file-meta")).toHaveText("47.7 MB · PDF");
  await expect(file(page).getByTestId("file-pdf")).toHaveCount(0);
  await expect(file(page).getByTestId("file-truncated")).toHaveCount(0);
});

test("a missing file says so and Retry reads again; the tab re-reads when the worktree changes", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");

  await openFile(page, "src/later.ts");
  await expect(file(page).getByTestId("file-not-found")).toContainText("File not found");
  await expect(file(page).getByTestId("file-not-found")).toContainText("~/src/code-foundry/src/later.ts");
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/src/later.ts`)}&text=${encodeURIComponent("export const later = 1;\n")}`);
  await file(page).getByTestId("file-retry").click();
  await expect(file(page).getByTestId("file-code")).toContainText("export const later = 1;");

  // A change the daemon announces (worktree_detail_updated) brings the new contents.
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/src/later.ts`)}&text=${encodeURIComponent("export const later = 2;\n")}`);
  await mockPost(`gh/touch?path=${encodeURIComponent(CF)}`);
  await expect(file(page).getByTestId("file-code")).toContainText("export const later = 2;");

  // Refresh reads again too.
  const before = (await calls()).filter((c) => c === `read ${CF}/src/later.ts`).length;
  await file(page).getByTestId("file-refresh").click();
  await expect.poll(async () => (await calls()).filter((c) => c === `read ${CF}/src/later.ts`).length).toBe(before + 1);
});

test("a path missing at the checkout opens the one file that ends with it (model-paths); two candidates stay not found", async ({ page }) => {
  await openApp(page);
  await worktreeTab(page, "s-1");

  // The checkout's file search lists src/app.ts once: "app.ts" (written from src/) finds it.
  await mockPost("files?project=repo-cf&path=src/app.ts&path=docs/a/spec.pdf&path=docs/b/spec.pdf");
  await openFile(page, "app.ts", 12);
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/src/app.ts`);
  await expect(file(page).getByTestId("file-code").locator('[data-line="12"][data-selected-line]').first()).toBeVisible();
  await expect(activeTab(page)).toHaveText("app.ts");

  // Two files end with "spec.pdf": no guess.
  await openFile(page, "spec.pdf");
  await expect(file(page).getByTestId("file-not-found")).toContainText("~/src/code-foundry/spec.pdf");
});

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
