import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";
import { keyboardPane, paneWith } from "./shell-surfaces";

/**
 * The finder's Text mode (file.find.text, cmd+shift+P; docs/notes/file-search-5-text-mode.md)
 * for what only the whole app shows: the chord through the keymap from a thread's prompt, the
 * dialog widening on Tab, the preview scrolled to the selected match painted solid with the
 * Custom Highlight API inside @pierre/diffs' shadow root, and Enter landing in the File tab at
 * the line with the find bar (the keyboard in the panel). Rows, streaming, toggles, errors,
 * selection and the actions' args are src/components/palette/TextFinder.test.tsx's and
 * src/lib/textSearch.test.ts's. SHOTS=<dir> also saves the PR's screenshots.
 */

const palette = (page: Page) => page.getByTestId("palette");

/** 120 lines; the needle on line 80 (and line 3), far from the top, so the preview has to scroll to it. */
const APP_TS = Array.from({ length: 120 }, (_, i) => {
  const n = i + 1;
  if (n === 3) return 'import { renderComposer } from "./composer";';
  if (n === 80) return "export function mount(root: Element): void { renderComposer(root, { compact: true }); }";
  return `// line ${String(n)}: keep the layout stable`;
}).join("\n");

test.beforeEach(async () => {
  await resetMock();
  await mockPost(`files?project=repo-cf&${["README.md", "src/app.ts", "docs/notes/x.md"].map((f) => `path=${encodeURIComponent(f)}`).join("&")}`);
  // On the mock's disk, so ReadFile (the preview, the File tab) and SearchText read the same text.
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/src/app.ts`)}&text=${encodeURIComponent(APP_TS)}`);
});

/** The palette dialog's width in CSS px. */
const dialogWidth = (page: Page) => page.locator('[data-region="palette"]').evaluate((el) => el.getBoundingClientRect().width);

/** The text of the preview's solid match, and where its middle sits in the scroll box (0 top, 1 bottom); null when nothing is painted. */
function currentMatch(page: Page): Promise<{ text: string; at: number } | null> {
  return page.evaluate(() => {
    const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const r = [...(reg.get("cf-text-search-current") ?? [])][0];
    const box = document.querySelector('[data-testid="text-preview-code"] [data-testid="file-code"]');
    if (!r || !box) return null;
    const scroller = box.hasAttribute("data-virtual") ? (box.firstElementChild ?? box) : box;
    const b = scroller.getBoundingClientRect();
    const m = r.getBoundingClientRect();
    return { text: r.toString(), at: (m.top + m.height / 2 - b.top) / b.height };
  });
}

test("cmd+shift+p opens Text mode wide; Tab narrows to Files; the preview centres the painted match; Enter lands in the File tab at the line with the find bar", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();

  await page.keyboard.press("Meta+Shift+p");
  await expect(palette(page)).toHaveAttribute("data-mode", "text");
  await expect(page.getByTestId("finder-input")).toBeFocused();
  const wide = await dialogWidth(page);
  await page.keyboard.press("Tab");
  await expect(palette(page)).toHaveAttribute("data-mode", "files");
  expect(await dialogWidth(page)).toBeLessThan(wide - 200);
  await page.keyboard.press("Tab");
  await expect(palette(page)).toHaveAttribute("data-mode", "text");
  expect(await dialogWidth(page)).toBe(wide);

  await page.keyboard.type("renderComposer");
  const selected = palette(page).locator('[data-testid="text-row"][data-selected]');
  await expect(selected).toHaveAttribute("data-line", "3");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("data-line", "80");
  await expect(page.getByTestId("text-preview-code")).toHaveAttribute("data-line", "80");
  await expect.poll(() => currentMatch(page).then((c) => c?.text ?? null)).toBe("renderComposer");
  const at = (await currentMatch(page))?.at ?? -1;
  expect(at).toBeGreaterThan(0.3);
  expect(at).toBeLessThan(0.7);

  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  const filePane = paneWith(page, "file");
  await expect(filePane.locator('[data-testid="shell-tab"][data-kind="file"]')).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("file-find-input")).toBeFocused();
  await expect(page.getByTestId("file-find-input")).toHaveValue("renderComposer");
  await expect(page.getByTestId("file-find-count")).toHaveText("2 of 2");
  const paneId = String(await filePane.getAttribute("data-pane-id"));
  await expect.poll(() => keyboardPane(page)).toBe(paneId);
  // The preview's paint went with the dialog.
  expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has("cf-text-search-current"))).toBe(false);
});

const shots = process.env.SHOTS;

/** Screenshots for the PR (both schemes), on the tree as it is: run before and after the change. */
test("text search screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = async (name: string, target: () => Locator) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await target().screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();

  // Files mode (before: no switch, no "tab search text").
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("app");
  await expect(palette(page).getByTestId("finder-row").first()).toBeVisible();
  await shot("files-mode", () => page.locator('[data-region="palette"]'));

  // Text mode with results and the preview (after only).
  const text = page.getByTestId("finder-mode-text");
  if ((await text.count()) > 0) {
    await page.keyboard.press("Tab");
    await page.getByTestId("finder-input").fill("renderComposer");
    await expect(palette(page).locator('[data-testid="text-row"][data-selected]')).toHaveAttribute("data-line", "3");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("text-preview-code")).toHaveAttribute("data-line", "80");
    await expect.poll(() => currentMatch(page).then((c) => c?.text ?? null)).toBe("renderComposer");
    await shot("text-mode", () => page.locator('[data-region="palette"]'));
    await page.keyboard.press("Tab");
  }

  // The tag in the prompt: app.ts at line 80 (before: the tag has no line).
  await page.getByRole("combobox").fill("app:80");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "src/app.ts");
  await page.keyboard.press("Meta+Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(threadPrompt(page).getByTestId("prompt-tag")).toBeVisible();
  await page.keyboard.type("why does this mount twice?");
  await shot("tag-with-line", () => page.getByTestId("thread-composer"));
});
