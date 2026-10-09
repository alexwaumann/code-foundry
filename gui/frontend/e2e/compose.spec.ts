import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

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
  await expect(projects).toHaveCount(3);
  await expect(projects.nth(0)).toContainText("CF");
  await expect(projects.nth(0)).toContainText("code-foundry");
  await expect(projects.nth(0)).toContainText("Local · ~/src/code-foundry");
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
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Describe what to build…");
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
  await expect(page.getByTestId("composer-input")).toHaveValue("Add a dark mode toggle\nin settings");
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
  await expect(page.getByTestId("composer-input")).toHaveValue("");
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
  await expect(input).toHaveValue("Please FAIL here");
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
  const chips = page.getByTestId("attachment");
  await expect(chips).toHaveCount(1);
  await expect(chips.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByTestId("composer-notice")).toHaveText("notes.txt: not a PNG, JPEG, GIF or WebP image");

  await input.setInputFiles([{ name: "other.png", mimeType: "image/png", buffer: PNG }]);
  await expect(chips).toHaveCount(2);
  await expect(page.getByTestId("composer-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "Remove other.png" }).click();
  await expect(chips).toHaveCount(1);

  // A pasted image lands as a chip too.
  await page.getByTestId("composer-input").evaluate((el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [...PNG]);
  await expect(chips).toHaveCount(2);

  await page.getByTestId("composer-input").fill("Match these screenshots");
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
  await expect(page.getByTestId("composer-input")).toHaveValue("Half-written idea");

  // Esc with text does nothing; with an empty draft it returns to the repo overview.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("composer-input").fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(row(page, "r:repo-gp")).toHaveAttribute("aria-selected", "true");
});
