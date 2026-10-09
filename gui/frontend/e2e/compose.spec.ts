import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

const OUTDATED = "The running daemon is older than the app. Restart it (Daemon → Restart) to use this feature.";

/** A 1x1 transparent PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test.beforeEach(async () => {
  await resetMock();
});

async function sessionCount(): Promise<number> {
  const res = await fetch(`${mockUrl}/__mock/sessions`);
  return ((await res.json()) as unknown[]).length;
}

async function staged(): Promise<{ path: string; name: string; mimeType: string; size: number }[]> {
  const res = await fetch(`${mockUrl}/__mock/attachments`);
  return (await res.json()) as { path: string; name: string; mimeType: string; size: number }[];
}

/** cmd+n, then cmd+<n> in the project picker: the composer for the nth project. */
async function compose(page: Page, n = 1): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press(`Meta+${String(n)}`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
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

function terminalFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest("[data-terminal-host]") != null);
}

test("cmd+n: project picker, cmd+1, type, Enter starts a thread in a new worktree", async ({ page }) => {
  await mockPost("session-new?delay=1500");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  const projects = palette.locator("[data-project]");
  await expect(projects).toHaveCount(4);
  await expect(projects.nth(0)).toContainText("CF");
  await expect(projects.nth(0)).toContainText("code-foundry");
  // The subtitle names where the repo lives: its GitHub slug, a remote, or "Local only".
  await expect(projects.getByTestId("project-source")).toHaveText([
    "alexwaumann/code-foundry · ~/src/code-foundry",
    "origin · ~/dotfiles",
    "alexwaumann/ghostty-playground · ~/src/ghostty-playground",
    "Local only · ~/src/sketches",
  ]);
  await expect(projects.nth(0)).toContainText("⌘1");
  await expect(projects.nth(2)).toContainText("⌘3");
  await expect(page.getByTestId("picker-hints")).toHaveText(/↑↓\s*Navigate\s*Enter\s*Select\s*Backspace\s*Back\s*Esc\s*Close/);
  // The search box filters.
  await page.keyboard.type("ghostty");
  await expect(projects).toHaveCount(1);
  await page.keyboard.press("Meta+1"); // by position in the full list, not the filtered one
  await expect(palette).toHaveCount(0);

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("composer-input")).toHaveAttribute("aria-placeholder", "Describe what to build…");
  await expect(page.getByTestId("composer")).toContainText("Describe what to build…");
  await expect(row(page, "r:repo-cf")).toHaveAttribute("aria-selected", "true");
  // Defaults: settings (opus / high), Auto, a new worktree from ListRefs' default ref.
  await expect(page.getByTestId("composer-model")).toHaveText("Opus 5.5");
  await expect(page.getByTestId("composer-effort")).toHaveText("High");
  await expect(page.getByTestId("composer-permission")).toHaveText("Auto");
  await expect(page.getByTestId("composer-worktree")).toHaveText("New worktree");
  await expect(page.getByTestId("composer-base")).toHaveText("From origin/main");

  await page.keyboard.type("Add a dark mode toggle");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("in settings");
  await expect(prompt(page)).toHaveAttribute("data-value", "Add a dark mode toggle\nin settings");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-send")).toHaveText("Creating worktree…");
  await expect(page.getByTestId("composer-input")).toBeDisabled();

  // The daemon's focus intent replaces the composer with the thread; its terminal has focus.
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  const key = (await created.getAttribute("data-row-key")) ?? "";
  expect(key).toMatch(/^s:s-new-\d+$/);
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => terminalFocused(page)).toBe(true);
  // Unnamed at first: the id stands in until the daemon names it.
  await expect(created.getByTestId("session-name")).toHaveText(key.slice(2));
  await expect(created.getByTestId("session-name")).toHaveText("add-a-dark-mode", { timeout: 5000 });

  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("session.new");
  expect(last?.args).toEqual({
    repo: "repo-cf",
    "new-worktree": "true",
    base: "origin/main",
    model: "opus",
    effort: "high",
    permission: "auto",
    prompt: "Add a dark mode toggle\nin settings",
  });
  // The new worktree is in the sidebar with the thread under it.
  const wt = "w:repo-cf::/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-add-a-dark-mode";
  await expect(row(page, wt)).toBeVisible();
  const keys = await page.getByRole("tree").locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(keys.indexOf(key)).toBe(keys.indexOf(wt) + 1);

  // The draft was cleared: a new composer for the repo starts empty.
  await compose(page);
  await expect(prompt(page)).toHaveAttribute("data-value", "");
});

test("pickers are keyboard operable; Tab goes prompt → pickers → send", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("Refactor the sidebar");

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-model")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-model-list")).toBeVisible();
  await page.keyboard.press("ArrowDown"); // opus -> sonnet
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-model-list")).toHaveCount(0);
  await expect(page.getByTestId("composer-model")).toHaveText("Sonnet 5.5");
  await expect(page.getByTestId("composer-model")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-effort")).toBeFocused();
  await page.keyboard.press("ArrowDown"); // opens
  await page.keyboard.press("ArrowDown"); // high -> xhigh
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-effort")).toHaveText("Extra high");

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

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-attach")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-worktree")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-base")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Filter refs…")).toBeFocused();
  await page.keyboard.type("release");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-base")).toHaveText("From origin/release/v0.3");

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-send")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  expect((await invocations()).at(-1)?.args).toEqual({
    repo: "repo-cf",
    "new-worktree": "true",
    base: "origin/release/v0.3",
    model: "sonnet",
    effort: "xhigh",
    permission: "supervised",
    prompt: "Refactor the sidebar",
  });
  await expect(page.locator('[data-row-kind="session"][aria-selected="true"]')).toBeVisible();
});

test("a failed start keeps the draft editable and shows why", async ({ page }) => {
  await mockPost("session-new?delay=300");
  await openApp(page);
  const before = await sessionCount();
  await compose(page);
  await page.keyboard.type("Please FAIL here");
  await page.keyboard.press("Enter");
  const error = page.getByTestId("composer-error");
  await expect(error).toHaveText("create worktree: git fetch origin main: exit status 128");
  const input = page.getByTestId("composer-input");
  await expect(input).toBeEnabled();
  await expect(prompt(page)).toHaveAttribute("data-value", "Please FAIL here");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("composer")).toBeVisible();
  expect(await sessionCount()).toBe(before);

  // Pick the current checkout instead: the base picker goes away. Editing clears the error.
  await page.getByTestId("composer-worktree").click();
  const options = page.getByTestId("composer-worktree-list").getByRole("option");
  await expect(options).toHaveText([/^New worktree/, /^Current checkout\s*main · ~\/src\/code-foundry/, /^feat\/sidebar/, /^fix\/resize/]);
  await options.filter({ hasText: "Current checkout" }).click();
  await expect(page.getByTestId("composer-worktree")).toHaveText("Current checkout");
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  await input.fill("Please work");
  await expect(error).toHaveCount(0);
  await input.press("Enter");
  await expect(page.locator('[data-row-kind="session"][aria-selected="true"]')).toBeVisible();
  const last = (await invocations()).at(-1);
  expect(last?.args).toEqual({ repo: "repo-cf", worktree: CF, model: "opus", effort: "high", permission: "auto", prompt: "Please work" });
  expect(await sessionCount()).toBe(before + 1);
});

test("attachments: picked, rejected, removed, staged on send", async ({ page }) => {
  await openApp(page);
  await compose(page);
  const input = page.getByTestId("composer-file-input");
  await input.setInputFiles([
    { name: "shot.png", mimeType: "image/png", buffer: PNG },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
  ]);
  const thumbs = page.getByTestId("attachment");
  await expect(thumbs).toHaveCount(1);
  await expect(thumbs.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByTestId("composer-notice")).toHaveText("notes.txt: not a PNG, JPEG, GIF or WebP image");

  await input.setInputFiles([{ name: "other.png", mimeType: "image/png", buffer: PNG }]);
  await expect(thumbs).toHaveCount(2);
  await expect(page.getByTestId("composer-notice")).toHaveCount(0);
  // Not referenced in the (empty) text: × removes it without asking.
  await page.getByRole("button", { name: "Remove other.png" }).click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(thumbs).toHaveCount(1);

  // A pasted image lands as a thumbnail too; into an empty prompt, with no chip.
  await pasteImage(page, "pasted.png");
  await expect(thumbs).toHaveCount(2);
  await expect(page.getByTestId("prompt-chip")).toHaveCount(0);

  await page.getByTestId("composer-input").fill("Match these screenshots");
  await expect(page.getByTestId("prompt-chip")).toHaveCount(0);
  await page.getByTestId("composer-input").press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const up = await staged();
  expect(up.map((a) => [a.name, a.mimeType, a.size])).toEqual([
    ["shot.png", "image/png", PNG.length],
    ["pasted.png", "image/png", PNG.length],
  ]);
  expect((await invocations()).at(-1)?.args.attachments).toBe(up.map((a) => a.path).join(","));
  await expect(page.locator('[data-row-kind="session"][aria-selected="true"]')).toBeVisible();
});

test("the draft survives switching away; Backspace goes back; Esc on an empty draft shows the repo", async ({ page }) => {
  await openApp(page);
  await compose(page, 3);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await page.keyboard.type("Half-written idea");
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);

  // Back through the picker: the selected repo is highlighted, Backspace returns to the commands.
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette.locator('[data-project="repo-cf"]')).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Backspace");
  await expect(palette).toHaveAttribute("data-mode", "commands");
  // Picking session.new in the palette shows the picker again, not model/effort prompts.
  await page.keyboard.type("new thread");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await compose(page, 3);
  await expect(prompt(page)).toHaveAttribute("data-value", "Half-written idea");

  // Esc with text does nothing; with an empty draft it returns to the repo overview.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("composer-input").fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(row(page, "r:repo-gp")).toHaveAttribute("aria-selected", "true");
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
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const [up] = await staged();
  const args = (await invocations()).at(-1)?.args;
  expect(args?.prompt).toBe(`Compare with the header and [Image: logo.png; ref=${up?.path ?? ""}] please`);
  expect(args?.attachments).toBe(up?.path);
});

test("the composer stays centered in the content pane at any size, as the draft grows and on errors", async ({ page }) => {
  await mockPost("session-new?delay=100");
  await openApp(page);
  await compose(page);
  const centered = async () => {
    const pane = await page.getByTestId("content-pane").boundingBox();
    const body = await page.getByTestId("composer-body").boundingBox();
    if (!pane || !body) return { dx: Infinity, dy: Infinity };
    return {
      dx: Math.round(Math.abs(body.x + body.width / 2 - (pane.x + pane.width / 2))),
      dy: Math.round(Math.abs(body.y + body.height / 2 - (pane.y + pane.height / 2))),
    };
  };
  for (const size of [
    { width: 1280, height: 800 },
    { width: 900, height: 560 },
    { width: 1680, height: 1050 },
  ]) {
    await page.setViewportSize(size);
    await expect.poll(centered).toEqual({ dx: 0, dy: 0 });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.type("Please FAIL here");
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`line ${String(i)}`);
  }
  await expect.poll(centered).toEqual({ dx: 0, dy: 0 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect.poll(centered).toEqual({ dx: 0, dy: 0 });
});

test("a local-only repository: local refs from main, no remote git commands", async ({ page }) => {
  await openApp(page);
  await compose(page, 4);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in sketches?");
  await expect(page.getByTestId("composer-base")).toHaveText("From main");
  await page.getByTestId("composer-base").click();
  const refs = page.getByTestId("composer-base-list").getByRole("option");
  await expect(refs).toHaveText([/^main\s*default$/, /^experiment\/shaders$/]);
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Try a new shader");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  expect((await invocations()).at(-1)?.args).toMatchObject({ repo: "repo-sk", "new-worktree": "true", base: "main" });
  await expect(page.locator('[data-row-kind="session"][aria-selected="true"]')).toBeVisible();

  // Its overview shows no git buttons, and fetch/pull/push/PR are not offered for it.
  await row(page, "w:repo-sk::/Users/dev/src/sketches").click();
  await expect(page.getByTestId("overview-page")).toBeVisible();
  await expect(page.locator('[data-command-button^="git."], [data-command-button^="pr."]')).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette.locator('[data-command="terminal.new"]')).toBeVisible();
  for (const name of ["git.fetch", "git.pull", "git.push", "pr.create", "pr.open"]) await expect(palette.locator(`[data-command="${name}"]`)).toHaveCount(0);
});

test("a daemon older than ListRefs/StageAttachment: a clear restart hint, not HTTP 404", async ({ page }) => {
  await mockPost("missing-rpc?rpc=RepoService/ListRefs&rpc=SessionService/StageAttachment");
  await openApp(page);
  await compose(page);
  await expect(page.getByTestId("composer-base")).toHaveText("From the default branch");
  await page.getByTestId("composer-base").click();
  await expect(page.getByTestId("composer-base-list").getByRole("status")).toHaveText(OUTDATED);
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-file-input").setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: PNG }]);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Match it");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-error")).toHaveText(OUTDATED);
  await expect(page.getByTestId("composer")).toBeVisible();
});

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
