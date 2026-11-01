import { expect, test, type Page } from "@playwright/test";
import { CF, composeProject, expectTooltip, freshCopyByDefault, invocations, mockPost, mockUrl, openApp, resetMock, row, testPdf } from "./fixtures";

/** A 1x1 transparent PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test.beforeEach(async () => {
  await resetMock();
});

async function threadCount(): Promise<number> {
  const res = await fetch(`${mockUrl}/__mock/threads`);
  return ((await res.json()) as unknown[]).length;
}

async function staged(): Promise<{ path: string; name: string; mimeType: string; size: number; pages: number }[]> {
  const res = await fetch(`${mockUrl}/__mock/attachments`);
  return (await res.json()) as { path: string; name: string; mimeType: string; size: number; pages: number }[];
}

/** cmd+n, then the nth project row of the picker: that project's composer. */
async function compose(page: Page, n = 1): Promise<void> {
  await composeProject(page, n);
}

/** The prompt as the draft stores it (chips as `![name](cf-attachment://id)` tokens). */
function prompt(page: Page) {
  return page.getByTestId("composer-prompt");
}

/** Pastes an image into the prompt the way WebKit/Chromium deliver a clipboard image. */
async function pasteImage(page: Page, name: string): Promise<void> {
  await page.getByTestId("composer-input").evaluate(
    (el, [file, bytes]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes as number[])], file, { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [name, [...PNG]] as const,
  );
}

/** The keyboard is in the selected thread's prompt (its composer). */
function promptFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest('[data-testid="thread-composer"]') != null);
}

// The picker's rows, sources, numbering, hints and ranking: unit-tested in src/components/compose/ProjectPicker.test.tsx;
// the composer's heading, placeholder, default pills, Creating worktree… and thread.new's args, and the
// cleared draft: src/components/compose/ComposerSend.test.tsx. What stays: the global chord, real
// typing, and the flow from thread.new over the daemon's streams.
test("cmd+n: project picker, cmd+1, type, Enter starts a thread in a new worktree", async ({ page }) => {
  await freshCopyByDefault();
  await mockPost("thread-new?delay=1500");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await page.keyboard.type("foundry");
  await page.keyboard.press("Meta+1"); // the top row of the list on screen
  await expect(palette).toHaveCount(0);

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // A composer has no sidebar row: nothing in the thread list is selected.
  await expect(page.getByTestId("thread-list").locator('[aria-selected="true"]')).toHaveCount(0);

  await page.keyboard.type("Add a dark mode toggle");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("in settings");
  await expect(prompt(page)).toHaveAttribute("data-value", "Add a dark mode toggle\nin settings");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-input")).toBeDisabled();

  // The daemon's focus intent replaces the composer with the thread; its prompt has focus.
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(created).toBeVisible();
  const key = (await created.getAttribute("data-row-key")) ?? "";
  expect(key).toMatch(/^s:s-new-\d+$/);
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  // While Claude starts the timeline looks like any working thread.
  await expect(page.getByTestId("thread-working")).toContainText("Working");
  await expect.poll(() => promptFocused(page)).toBe(true);
  // Unnamed at first: the id stands in until the daemon names it.
  await expect(created.getByTestId("thread-name")).toHaveText(key.slice(2));
  await expect(created.getByTestId("thread-name")).toHaveText("Add a dark mode", { timeout: 5000 });
  expect((await invocations()).at(-1)?.args.prompt).toBe("Add a dark mode toggle\nin settings");
  // The prompt goes out as the thread's first message once Claude is up.
  await expect(page.getByTestId("thread-user").first()).toContainText("Add a dark mode toggle", { timeout: 8000 });
  // The thread's row names its project and the new worktree's branch; it is the newest thread.
  await expect(created.getByTestId("row-project")).toHaveText("code-foundry");
  await expect(created.getByTestId("row-branch")).toHaveText("cf/add-a-dark-mode");
  // Starting, it sits under Working; once idle it joins the idle threads (sorted by their
  // last activity, so where among them depends on what else just ran).
  await expect(created).toHaveAttribute("data-section", "idle", { timeout: 8000 });
});

test("pickers are keyboard operable; Tab goes prompt → pickers → send", async ({ page }) => {
  await freshCopyByDefault();
  await openApp(page);
  await compose(page);
  await page.keyboard.type("Refactor the sidebar");

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-model")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-model-list")).toBeVisible();
  // The daemon's model registry, from the settings schema.
  await expect(page.getByTestId("composer-model-list").getByRole("option")).toHaveText([
    "Opus 5.5",
    "Opus 4.8",
    "Opus 4.7",
    "Sonnet 5.5",
    "Sonnet 5",
    "Sonnet 4.6",
    "Haiku 5.5",
    "Haiku 4.5",
  ]);
  await page.keyboard.press("ArrowDown"); // Sonnet 5 -> Sonnet 4.6
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-model-list")).toHaveCount(0);
  await expect(page.getByTestId("composer-model")).toHaveText("Sonnet 4.6");
  await expect(page.getByTestId("composer-model")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-effort")).toBeFocused();
  await page.keyboard.press("ArrowDown"); // opens
  await page.keyboard.press("ArrowDown"); // medium -> high
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-effort")).toHaveText("High");

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-permission")).toBeFocused();
  await page.keyboard.press("Enter");
  const perms = page.getByTestId("composer-permission-list").getByRole("option");
  await expect(perms).toHaveText([/^Supervised/, /^Accept edits/, /^Auto/]); // never full access
  await page.keyboard.press("ArrowUp"); // auto -> accept-edits
  await page.keyboard.press("ArrowUp"); // -> supervised
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-permission")).toHaveText("Supervised");
  // Escape closes a picker without changing it.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-permission-list")).toHaveCount(0);
  await expect(page.getByTestId("composer-permission")).toHaveText("Supervised");
  await expect(page.getByTestId("composer-permission")).toBeFocused();

  // At once: reopened while it still fades out, the list takes the keyboard all the same.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-permission-list").locator("[cmdk-root]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-permission")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-attach")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-worktree")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-base")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Filter branches…")).toBeFocused();
  await page.keyboard.type("release");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-base")).toHaveText("From release/v0.3");
  // A pick in the Work in row hands the keyboard back to the prompt (composer-set-picks.md),
  // again once the list's exit animation ends.
  await expect(page.getByTestId("composer-base-list")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await page.getByTestId("composer-base").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-send")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  expect((await invocations()).at(-1)?.args).toEqual({
    project: "repo-cf",
    "new-worktree": "true",
    base: "release/v0.3",
    model: "claude-sonnet-4-6[1m]",
    effort: "high",
    permission: "supervised",
    prompt: "Refactor the sidebar",
  });
  await expect(page.locator('[data-row-kind="thread"][aria-selected="true"]')).toBeVisible();
});

// A failed start (the refusal, the draft kept and editable, Work in's options, Project folder dropping the base,
// editing clearing the error, the send in the folder): unit-tested in src/components/compose/ComposerSend.test.tsx.

// The current checkout's branch (read-only, not a Tab stop, live), an existing branch and the base slot, and Work in
// by default (in place; a pick for its draft only): unit-tested in src/components/compose/ComposerSend.test.tsx.

// Picked, rejected (the notice), removed without a confirm, staged on send in the draft's order:
// unit-tested in src/components/compose/ComposerAttachments.test.tsx. What stays: a real paste.
test("attachments: a pasted image lands as a thumbnail; into an empty prompt, with no chip", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await pasteImage(page, "pasted.png");
  await expect(page.getByTestId("attachment")).toHaveCount(1);
  await expect(page.getByTestId("prompt-chip")).toHaveCount(0);
});

// A native drop (images and PDFs staged by path, other paths inserted, another target ignored, the send reusing
// the staged paths): unit-tested in src/components/compose/hostFiles.test.tsx.

test("the draft survives switching away; Esc on an empty draft shows the project", async ({ page }) => {
  await openApp(page);
  await compose(page, 3);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await page.keyboard.type("Half-written idea");
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);

  // No project highlighted in the picker, Backspace back to the commands, and thread.new from the
  // palette showing the picker: unit-tested in src/components/palette/CommandPalette.test.tsx.
  await compose(page, 3);
  await expect(prompt(page)).toHaveAttribute("data-value", "Half-written idea");

  // Esc with text does nothing; with an empty draft it returns to the Projects page.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("composer-input").fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("projects-page")).toBeVisible();
});

test("image chips: inserted at the caret, one unit for arrows and Backspace, × asks while referenced, sent as references", async ({ page }) => {
  await openApp(page);
  await compose(page);
  const input = page.getByTestId("composer-input");
  const chips = page.getByTestId("prompt-chip");
  const thumbs = page.getByTestId("attachment");

  await page.keyboard.type("Compare");
  await pasteImage(page, "image.png");
  await expect(thumbs).toHaveCount(1);
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute("aria-label", "Image attachment, image.png, 1 KB");
  await expect(chips.first()).toContainText("image.png");
  await expect(chips.first()).toContainText("1 KB");
  const id = (await chips.first().getAttribute("data-attachment-id")) ?? "";
  expect(id).toMatch(/^a\d+$/);
  const chip = `![image.png](cf-attachment://${id})`;
  // A space before (after a word) and after the chip; typing continues after it.
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare ${chip} `);
  await page.keyboard.type("with the header");
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare ${chip} with the header`);

  // The arrows step over the chip in one press.
  for (let i = 0; i < " with the header".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("|");
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare |${chip} with the header`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("|");
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare |${chip}| with the header`);
  await page.keyboard.press("Backspace");

  // Backspace removes the chip as one unit and only the reference: the thumbnail stays.
  await page.keyboard.press("Backspace");
  await expect(chips).toHaveCount(0);
  await expect(prompt(page)).toHaveAttribute("data-value", "Compare | with the header");
  await expect(thumbs).toHaveCount(1);
  // Undo brings the reference back.
  await page.keyboard.press("Meta+z");
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare |${chip} with the header`);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare ${chip} with the header`);
  // A selection extends across the chip; typing replaces it like any text.
  await page.waitForTimeout(600); // a separate undo step (ProseMirror groups edits within 500 ms)
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.type("X ");
  await expect(prompt(page)).toHaveAttribute("data-value", "Compare X with the header");
  await expect(thumbs).toHaveCount(1);
  await page.keyboard.press("Meta+z");
  await expect(prompt(page)).toHaveAttribute("data-value", `Compare ${chip} with the header`);

  // × on a referenced thumbnail asks first (centered); Cancel keeps both.
  const dialog = page.getByTestId("confirm-dialog");
  await page.getByRole("button", { name: "Remove image.png" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Remove image.png from the message?");
  await expect(dialog).toContainText("It is referenced in your text; removing it also removes every reference.");
  await expect(dialog.getByTestId("confirm-ok")).toHaveText("Confirm");
  const box = await dialog.boundingBox();
  const vp = page.viewportSize();
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - (vp?.height ?? 0) / 2)).toBeLessThan(2);
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(thumbs).toHaveCount(1);
  await expect(chips).toHaveCount(1);

  // Confirm removes the image and every reference to it.
  await page.getByRole("button", { name: "Remove image.png" }).click();
  await dialog.getByTestId("confirm-ok").click();
  await expect(thumbs).toHaveCount(0);
  await expect(chips).toHaveCount(0);
  await expect(prompt(page)).toHaveAttribute("data-value", "Compare with the header");
  await expect(input).toBeFocused();

  // Send: each chip becomes [Image: name; ref=<staged path>] where it stands.
  await page.keyboard.press("End");
  await page.keyboard.type(" and");
  await pasteImage(page, "logo.png");
  await page.keyboard.type("please");
  await expect(chips).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  const [up] = await staged();
  const args = (await invocations()).at(-1)?.args;
  expect(args?.prompt).toBe(`Compare with the header and [Image: logo.png; ref=${up?.path ?? ""}] please`);
  expect(args?.attachments).toBe(up?.path);
});

// A local-only repository's Branch from (local branches, the rule, the base sent): unit-tested in
// src/components/compose/ComposerSend.test.tsx; no remote git commands for it is the daemon's availability
// (internal/command/commands_gitops_test.go).

test("an image dropped on the prompt attaches it and puts a chip at the caret", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("Use this logo");
  await page.getByTestId("composer-input").evaluate((el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "drop.png", { type: "image/png" }));
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...PNG]);
  await expect(page.getByTestId("attachment")).toHaveCount(1);
  const chip = page.getByTestId("prompt-chip");
  await expect(chip).toHaveCount(1);
  const id = (await chip.getAttribute("data-attachment-id")) ?? "";
  await expect(prompt(page)).toHaveAttribute("data-value", `Use this logo ![drop.png](cf-attachment://${id}) `);
  await expect(page.getByTestId("composer-card")).not.toHaveAttribute("data-dragging");
});

/** Pastes plain text into the prompt (chip tokens in it become chips). */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

// The preview's name, size and image, Esc and × closing it with focus back on the thumbnail, and × on the tile
// opening none: unit-tested in src/components/compose/ComposerAttachments.test.tsx. What stays: the geometry and
// the backdrop's outside press.
test("attachment preview: centred in the window; the backdrop closes it and focus returns", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.getByTestId("composer-file-input").setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: PNG }]);
  const open = page.getByTestId("attachment-open");
  await expect(open).toHaveCSS("cursor", "pointer");
  const preview = page.getByTestId("attachment-preview");
  await open.click();
  await expect(preview).toBeVisible();
  // Centered in the window.
  const box = await preview.boundingBox();
  const vp = page.viewportSize();
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - (vp?.height ?? 0) / 2)).toBeLessThan(2);
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (vp?.width ?? 0) / 2)).toBeLessThan(2);
  // The backdrop. Moved onto first: Chromium misses Radix's outside-press when the
  // pointer jumps there and presses in one go (the confirm dialog too); WebKit does not.
  await page.mouse.move(8, 8);
  await page.mouse.down();
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("attachment preview: from an inline chip by click or Space; Enter next to a chip still sends", async ({ page }) => {
  await openApp(page);
  await compose(page);
  const input = page.getByTestId("composer-input");
  const chip = page.getByTestId("prompt-chip");
  const preview = page.getByTestId("attachment-preview");
  await page.keyboard.type("Compare");
  await pasteImage(page, "image.png");
  await page.keyboard.type("with the header");
  await expect(chip).toHaveCSS("cursor", "pointer");
  const id = (await chip.getAttribute("data-attachment-id")) ?? "";
  const value = `Compare ![image.png](cf-attachment://${id}) with the header`;
  await expect(prompt(page)).toHaveAttribute("data-value", value);

  await chip.click();
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-attachment-id", id);
  await expect(preview.getByRole("heading")).toHaveText("image.png");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(input).toBeFocused();

  // The chip is still selected: Space opens the preview again rather than replacing it.
  await page.keyboard.press("Space");
  await expect(preview).toBeVisible();
  await page.getByTestId("attachment-preview-close").click();
  await expect(preview).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(prompt(page)).toHaveAttribute("data-value", value);

  // From the keyboard: the caret next to the chip, Shift+Arrow selects it, Space previews.
  await page.keyboard.press("ArrowRight"); // off the selected chip: the caret right after it
  await page.keyboard.press("Space");
  await expect(prompt(page)).toHaveAttribute("data-value", value.replace(") with", ")  with"));
  await expect(preview).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Space");
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await expect(prompt(page)).toHaveAttribute("data-value", value);

  // Enter with the caret right after the chip sends the thread.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  await expect(preview).toHaveCount(0);
});

test("attachment preview: a chip whose image is gone opens nothing", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("See");
  await pasteText(page, " ![gone.png](cf-attachment://a999) ");
  const chip = page.getByTestId("prompt-chip");
  await expect(chip).toHaveAttribute("data-missing", "true");
  await expectTooltip(page, chip, "gone.png (removed)");
  await expect(chip).not.toHaveCSS("cursor", "pointer");
  await chip.click();
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("attachment-preview")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

/** Pastes a file into the prompt the way WebKit/Chromium deliver a copied file. */
async function pasteFile(page: Page, name: string, type: string, data: Buffer): Promise<void> {
  await page.getByTestId("composer-input").evaluate(
    (el, [file, mime, bytes]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes as number[])], file, { type: mime }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [name, type, [...data]] as const,
  );
}

// The attach button's label and accept list, the tile's kind, pages and label, the preview's size line, no notice,
// the staged page counts and the [PDF: …] prompt: unit-tested in src/components/compose/ComposerAttachments.test.tsx.
// What stays: pdf.js drawing the tile, the chip and the pages, the canvases' backing size, the preview fitting the
// window, and a real paste.
test("PDFs: picked and pasted, a first-page tile and a chip with pages, previewed page by page", async ({ page }) => {
  await openApp(page);
  await compose(page);
  const two = testPdf(2);
  const tiles = page.getByTestId("attachment");
  const chips = page.getByTestId("prompt-chip");

  // Picked, with prose in the prompt: a tile and a chip at the caret.
  await page.keyboard.type("Summarize");
  await page.getByTestId("composer-file-input").setInputFiles([{ name: "spec.pdf", mimeType: "application/pdf", buffer: two }]);
  await expect(tiles).toHaveCount(1);
  // pdf.js drew the first page.
  await expect(tiles.first().locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute("data-attachment-kind", "pdf");
  await expect(chips.first()).toHaveAttribute("aria-label", "PDF attachment, spec.pdf, 2 pages");
  await expect(chips.first()).toContainText("2 pages");
  await expect(chips.first().locator("img")).toHaveAttribute("src", /^data:image\/png/);

  // The preview: a canvas per page, each drawn.
  const preview = page.getByTestId("attachment-preview");
  const open = page.getByTestId("attachment-open");
  await open.click();
  await expect(preview).toBeVisible();
  const pages = preview.getByTestId("pdf-page");
  await expect(pages).toHaveCount(2);
  await expect(pages.locator("canvas")).toHaveCount(2);
  await expect(pages.first()).toHaveAttribute("data-rendered", "true");
  await pages.nth(1).scrollIntoViewIfNeeded();
  await expect(pages.nth(1)).toHaveAttribute("data-rendered", "true");
  // Drawn at the column's width, in device pixels.
  const drawn = await pages.first().locator("canvas").evaluate((c: HTMLCanvasElement) => ({ w: c.width, css: c.getBoundingClientRect().width, ratio: window.devicePixelRatio }));
  expect(drawn.w).toBeGreaterThanOrEqual(Math.floor(drawn.css * drawn.ratio) - 1);
  // Capped like an image: within the window.
  const box = await preview.boundingBox();
  const vp = page.viewportSize();
  expect((box?.height ?? 0) <= (vp?.height ?? 0)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(open).toBeFocused();

  // Pasted: another tile, and a chip at the caret.
  await page.getByTestId("composer-input").focus();
  await page.keyboard.press("End");
  await page.keyboard.type("and");
  await pasteFile(page, "notes.pdf", "application/pdf", testPdf(1));
  await expect(tiles).toHaveCount(2);
  await expect(chips.nth(1)).toHaveAttribute("aria-label", "PDF attachment, notes.pdf, 1 page");
  // The chip opens the same preview.
  await chips.nth(1).click();
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("pdf-page")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await page.getByTestId("composer-input").press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  // With pdf.js's page counts, which the daemon takes when it has no pdfinfo.
  expect((await staged()).map((a) => [a.name, a.pages])).toEqual([
    ["spec.pdf", 2],
    ["notes.pdf", 1],
  ]);
});

// Over 20 MB rejected and over 10 pages sent as a path with its notice: unit-tested in
// src/components/compose/ComposerAttachments.test.tsx.

test.describe("a long PDF's preview", () => {
  test.use({ deviceScaleFactor: 3 });

  test("draws pages at most at 2x and releases the ones scrolled far away", async ({ page }) => {
    await openApp(page);
    await compose(page);
    await page.getByTestId("composer-file-input").setInputFiles([{ name: "book.pdf", mimeType: "application/pdf", buffer: testPdf(30) }]);
    await expect(page.getByTestId("attachment")).toHaveAttribute("data-pages", "30");
    await page.getByTestId("attachment-open").click();
    const preview = page.getByTestId("attachment-preview");
    const pages = preview.getByTestId("pdf-page");
    await expect(pages).toHaveCount(30);
    const first = pages.first();
    await expect(first).toHaveAttribute("data-rendered", "true");
    // The backing store is capped at 2x the CSS size, not the screen's 3x.
    const drawn = await first.locator("canvas").evaluate((c: HTMLCanvasElement) => ({ w: c.width, css: c.getBoundingClientRect().width }));
    expect(drawn.w).toBeGreaterThan(drawn.css * 1.9);
    expect(drawn.w).toBeLessThanOrEqual(Math.ceil(drawn.css * 2) + 1);

    // At the end, the first page is far away: its canvas is released, its placeholder back.
    const scroller = preview.getByTestId("pdf-pages");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(pages.last()).toHaveAttribute("data-rendered", "true");
    await expect(first).not.toHaveAttribute("data-rendered");
    await expect(first).toContainText("Page 1");
    expect(await first.locator("canvas").evaluate((c: HTMLCanvasElement) => c.width * c.height)).toBe(0);
    // Back at the top it is drawn again, and the last page released.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(first).toHaveAttribute("data-rendered", "true");
    await expect(pages.last()).not.toHaveAttribute("data-rendered");
  });
});
