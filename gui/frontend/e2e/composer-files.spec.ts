import { expect, test, type Page } from "@playwright/test";
import { composeProject, invocations, mockPost, mockUrl, openApp, resetMock } from "./fixtures";

// `@` file completion against the mock's SearchFiles (mock/filesystem.ts): each test sets
// the projects' files with POST /__mock/files; the mock ranks like internal/fuzzy (tier,
// then shorter path) and logs "search <project> <query>" per request.

const FILES = ["internal/api/thread.go", "gui/frontend/src/api/threads.ts", "internal/store/thread/fork.go", "README.md"];

async function setFiles(project: string, files: readonly string[]): Promise<void> {
  await mockPost(`files?project=${project}&${files.map((f) => `path=${encodeURIComponent(f)}`).join("&")}`);
}

test.beforeEach(async () => {
  await resetMock();
  await setFiles("repo-cf", FILES);
  // "@thr…" would also list the mock's "Write thread docs" in a Threads group above the
  // files (composer-threads.spec.ts covers that group): archived, it is not offered.
  await mockPost("thread/archive?id=s-5");
});

/** cmd+n, then the nth project row of the picker: that project's composer. */
async function compose(page: Page, n = 1): Promise<void> {
  await composeProject(page, n);
}

/** The prompt as the draft stores it (tags as tokens). */
const value = (page: Page) => page.getByTestId("composer-prompt");
const card = (page: Page) => page.getByTestId("completion-card");
const rows = (page: Page) => card(page).getByTestId("completion-item");
const labels = (page: Page) => card(page).getByTestId("completion-label");
const tags = (page: Page) => page.getByTestId("prompt-tag");
/** The tooltip's visible line (Radix also renders a visually hidden copy for screen readers). */
const tip = (page: Page) => page.getByTestId("prompt-tag-tooltip").locator("p").first();

async function newThreads(): Promise<number> {
  return (await invocations()).filter((i) => i.name === "thread.new").length;
}

/** The mock's SearchFiles calls ("search <project> <query>"). */
async function searches(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/files/calls`);
  return ((await res.json()) as string[]).filter((c) => c.startsWith("search "));
}

const THREAD_GO = "[thread.go](cf-file://repo-cf/internal/api/thread.go)";

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no box for ${testId}`);
  return box;
}

/** The composer card and its worktree row (the completion card must move neither). */
async function composerBoxes(page: Page): Promise<{ composer: Box; row: Box }> {
  return { composer: await boxOf(page, "composer-card"), row: await boxOf(page, "composer-worktree-row") };
}

const setZoom = (page: Page, z: number) => page.evaluate(`import("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setZoom(${String(z)}))`);

/** The list's height in layout px and how many rows it shows whole. */
function listFit(page: Page) {
  return card(page)
    .getByRole("listbox")
    .evaluate((list) => {
      const box = list.getBoundingClientRect();
      const whole = [...list.querySelectorAll('[role="option"]')].filter((o) => {
        const r = o.getBoundingClientRect();
        return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
      }).length;
      return { height: list.clientHeight, whole, scrolls: list.scrollHeight > list.clientHeight };
    });
}

/** 20 files f01…f20 (with their directory src/, 21 rows for @src): more rows than the card shows. */
const MANY = Array.from({ length: 20 }, (_, i) => `src/f${String(i + 1).padStart(2, "0")}.ts`);

test("type @thr: file rows; Enter inserts the base name and a space without sending; send gets @cf-file://", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@thr");
  await expect(card(page)).toBeVisible();
  // One project: no heading. Daemon order (tier, then shorter path); a directory ends with "/".
  await expect(card(page).getByTestId("completion-group")).toHaveCount(0);
  await expect(labels(page)).toHaveText(["thread/", "thread.go", "threads.ts", "fork.go"]);
  await expect(rows(page).nth(1)).toContainText("internal/api/thread.go");
  await expect(rows(page).nth(1).getByTestId("completion-hit")).toHaveText(["thr"]);
  await expect(labels(page).nth(1)).toHaveCSS("font-family", /mono|Menlo|Monaco/i);
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(card(page).getByRole("listbox")).toHaveAttribute("aria-label", "Files");
  await expect(card(page).getByTestId("completion-hints")).toHaveText(/↑\s*↓\s*move\s*⏎\s*⇥\s*insert\s*esc\s*dismiss/);
  expect(await searches()).toContain("search repo-cf thr");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", `${THREAD_GO} `);
  await expect(tags(page)).toHaveText(["thread.go"]);
  await expect(tags(page).nth(0)).toHaveAttribute("data-tag-kind", "file");
  expect(await newThreads()).toBe(0);

  // One project: the tooltip is the path alone.
  await tags(page).nth(0).hover();
  await expect(tip(page)).toHaveText("internal/api/thread.go");
  await page.mouse.move(0, 0);

  await page.keyboard.type("explain it");
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  const prompt = (await invocations()).at(-1)?.args.prompt;
  expect(prompt).toBe("@cf-file://repo-cf/internal/api/thread.go explain it");
  expect(prompt).toContain("@cf-file://repo-cf/internal/api/thread.go ");
});

test("Escape leaves the text; no matches says so; a click inserts a directory; Tab inserts", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@thr");
  await expect(rows(page)).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", "@thr");
  await expect(page.getByTestId("composer")).toBeVisible();

  await page.keyboard.type(" @zzz");
  await expect(card(page).getByTestId("completion-empty")).toHaveText("No threads or files match");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("READM");
  await expect(labels(page)).toHaveText(["README.md"]);
  await page.keyboard.press("Tab");
  await expect(value(page)).toHaveAttribute("data-value", "@thr [README.md](cf-file://repo-cf/README.md) ");
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await page.keyboard.type("@thre");
  await rows(page).filter({ has: page.getByTestId("completion-label").getByText("thread/", { exact: true }) }).click();
  await expect(value(page)).toHaveAttribute("data-value", "@thr [README.md](cf-file://repo-cf/README.md) [thread/](cf-file://repo-cf/internal/store/thread/) ");
  await expect(tags(page)).toHaveText(["README.md", "thread/"]);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await tags(page).nth(1).hover();
  await expect(tip(page)).toHaveText("internal/store/thread/");
  expect(await newThreads()).toBe(0);
});

test("navigating the card with arrows searches nothing more; re-opening with the same query is instant", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@thr");
  await expect(rows(page)).toHaveCount(4);
  await page.waitForTimeout(300); // let the debounce settle
  const before = await searches();
  for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowDown", "ArrowDown"]) await page.keyboard.press(key);
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true"); // wrapped
  await page.waitForTimeout(300);
  expect(await searches()).toEqual(before);

  // A space ends the trigger; Backspace puts the caret back in it: the cached answer, no request.
  await page.keyboard.type(" ");
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(rows(page)).toHaveCount(4);
  await page.waitForTimeout(300);
  expect(await searches()).toEqual(before);
});

test("a second project: files grouped by project, the primary first; tooltips name the project; removing the project removes its file tag after a confirm", async ({ page }) => {
  await setFiles("repo-cf", ["internal/api/thread.go", "README.md"]);
  await setFiles("repo-sk", ["internal/api/thread.go", "sketch.md"]);
  await openApp(page);
  await compose(page);
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await expect(page.getByTestId("composer-member")).toHaveCount(2);

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("@thread.go");
  await expect(card(page).getByTestId("completion-group")).toHaveText(["code-foundry", "sketches"]);
  await expect(labels(page)).toHaveText(["thread.go", "thread.go"]);
  expect(await searches()).toEqual(expect.arrayContaining(["search repo-cf thread.go", "search repo-sk thread.go"]));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const SK = "[thread.go](cf-file://repo-sk/internal/api/thread.go)";
  await expect(value(page)).toHaveAttribute("data-value", `${SK} `);
  await page.keyboard.type("and @thread.go");
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("Enter");
  await expect(value(page)).toHaveAttribute("data-value", `${SK} and ${THREAD_GO} `);

  // More than one project: the tooltip starts with the project's name.
  await tags(page).nth(0).hover();
  await expect(tip(page)).toHaveText("sketches/internal/api/thread.go");
  await page.mouse.move(0, 0);
  await expect(tip(page)).toHaveCount(0);
  await tags(page).nth(1).hover();
  await expect(tip(page)).toHaveText("code-foundry/internal/api/thread.go");
  await page.mouse.move(0, 0);

  // Sketches as the primary: its group comes first.
  await page.getByTestId("composer-primary").click();
  await page.getByTestId("composer-primary-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await expect(page.getByTestId("composer-primary")).toHaveText("sketches");
  await page.getByTestId("composer-input").click();
  await page.keyboard.press("End");
  await page.keyboard.type("@thread.go");
  await expect(card(page).getByTestId("completion-group")).toHaveText(["sketches", "code-foundry"]);
  await page.keyboard.press("Escape");
  for (let i = 0; i < "@thread.go".length; i++) await page.keyboard.press("Backspace");
  await expect(value(page)).toHaveAttribute("data-value", `${SK} and ${THREAD_GO} `);

  // Cancel keeps both; confirm removes the project and its file tag.
  const dialog = page.getByTestId("confirm-dialog");
  await page.getByRole("button", { name: "Remove sketches" }).click();
  await expect(dialog).toContainText("Remove sketches from the thread?");
  await expect(dialog).toContainText("1 reference to sketches in your text will be removed.");
  await dialog.getByTestId("confirm-cancel").click();
  await expect(tags(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Remove sketches" }).click();
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("composer-member")).toHaveCount(0);
  await expect(tags(page)).toHaveText(["thread.go"]);
  await expect(value(page)).toHaveAttribute("data-value", `and ${THREAD_GO}`);
  // One project again: no prefix.
  await tags(page).nth(0).hover();
  await expect(tip(page)).toHaveText("internal/api/thread.go");
});

test("Enter before the first answer does not send the half-typed reference", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("look at @READM");
  await page.keyboard.press("Enter"); // within the debounce: nothing has answered yet
  await expect(labels(page)).toHaveText(["README.md"]);
  expect(await newThreads()).toBe(0);
  await page.keyboard.press("Enter");
  await expect(value(page)).toHaveAttribute("data-value", "look at [README.md](cf-file://repo-cf/README.md) ");
  expect(await newThreads()).toBe(0);
});

test("a slow search says Searching… until the rows land; Escape before the first answer keeps the card closed and Enter sends", async ({ page }) => {
  await mockPost("files/search?delay=900");
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@READM");
  await expect(card(page).getByTestId("completion-searching")).toHaveText("Searching…");
  await expect(card(page).getByTestId("completion-hints")).toBeHidden();
  await expect(labels(page)).toHaveText(["README.md"]);
  await page.keyboard.press("Enter");
  await expect(value(page)).toHaveAttribute("data-value", "[README.md](cf-file://repo-cf/README.md) ");

  // A new query nothing has answered (no prefix of it is cached): Escape at once, then the
  // answer lands.
  const answered = page.waitForResponse((r) => r.url().endsWith("/SearchFiles") && (r.request().postData() ?? "").includes('"fork"'));
  await page.keyboard.type("@fork");
  await page.keyboard.press("Escape");
  await answered;
  await expect(card(page)).toHaveCount(0);
  expect(await searches()).toContain("search repo-cf fork");
  expect(await newThreads()).toBe(0);
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  expect((await invocations()).at(-1)?.args.prompt).toBe("@cf-file://repo-cf/README.md @fork");
});

test("a failing search: Enter waits for the answer (no match), the next Enter closes the card, the one after sends", async ({ page }) => {
  await mockPost("files/search?fail=1&delay=300");
  await openApp(page);
  await compose(page);
  await page.keyboard.type("@READM");
  await page.keyboard.press("Enter");
  await expect(card(page).getByTestId("completion-empty")).toHaveText("No threads or files match");
  expect(await newThreads()).toBe(0);
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  expect(await newThreads()).toBe(0);
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  expect((await invocations()).at(-1)?.args.prompt).toBe("@READM");
});

// The card hangs under the worktree row, out of flow: it moves neither the composer card
// nor that row, and its height is capped to the window below it (layout px = viewport px
// over the zoom). 90% takes 100%'s path (the full card fits either way), so it is left out.
for (const zoom of [100, 125, 150]) {
  test(`at ${String(zoom)}%: the file card hangs under the worktree row, moves nothing and fits the window`, async ({ page }) => {
    await setFiles("repo-cf", MANY);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openApp(page);
    await setZoom(page, zoom);
    await expect(page.locator("html")).toHaveCSS("zoom", String(zoom / 100));
    await compose(page);
    const before = await composerBoxes(page);
    await page.keyboard.type("@src");
    await expect(rows(page)).toHaveCount(21);
    const after = await composerBoxes(page);
    expect(after).toEqual(before);
    const pop = await boxOf(page, "completion-card");
    expect(pop.y).toBeGreaterThanOrEqual(after.row.y + after.row.height);
    expect(Math.abs(pop.x - after.composer.x)).toBeLessThan(1);
    expect(Math.abs(pop.width - after.composer.width)).toBeLessThan(1);
    // The visible bottom: the composer's scrolling section (the pane ends 8px above the window).
    const section = await boxOf(page, "composer");
    const bottom = Math.min(page.viewportSize()?.height ?? 0, section.y + section.height);
    // 16 layout px stay free under it (a pixel of rounding).
    expect(pop.y + pop.height).toBeLessThanOrEqual(bottom - 16 * (zoom / 100) + 1);
    const fit = await listFit(page);
    expect(fit.scrolls).toBe(true);
    // A 1000px window has room for the full card at 100%: ~8 rows (15.5rem).
    // Zoomed in, the same window is shorter in layout px: fewer whole rows.
    if (zoom <= 100) expect(fit.height).toBe(248);
    else {
      // Capped to whole rows (28px each, 8px padding), ending at most a row above the
      // 16 layout px margin: a missing or doubled zoom division would miss both.
      expect(fit.height).toBeLessThan(248);
      expect((fit.height - 8) % 28).toBe(0);
      expect(pop.y + pop.height).toBeGreaterThan(bottom - (16 + 28) * (zoom / 100) - 1);
    }
    expect(fit.whole).toBeGreaterThanOrEqual(1);

    // Arrowing to the last row scrolls the list only: the composer stays put.
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).nth(20)).toHaveAttribute("aria-selected", "true");
    expect(await composerBoxes(page)).toEqual(before);
    const last = await rows(page).nth(20).boundingBox();
    const list = await card(page).getByRole("listbox").boundingBox();
    expect(last && list && last.y + last.height <= list.y + list.height + 0.5).toBe(true);

    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    expect(await composerBoxes(page)).toEqual(before);
  });
}

test("a short window shows fewer rows; a taller one all eight; a very short one drops the hints", async ({ page }) => {
  await setFiles("repo-cf", MANY);
  await page.setViewportSize({ width: 1280, height: 560 });
  await openApp(page);
  await compose(page);
  const before = await composerBoxes(page);
  await page.keyboard.type("@src");
  await expect(rows(page)).toHaveCount(21);
  expect(await composerBoxes(page)).toEqual(before);
  const pop = await boxOf(page, "completion-card");
  expect(pop.y + pop.height).toBeLessThanOrEqual(560 - 16 + 1);
  const short = await listFit(page);
  expect(short.height).toBeLessThan(248);
  expect((short.height - 8) % 28).toBe(0);
  expect(short.whole).toBeGreaterThanOrEqual(1);
  expect(short.whole).toBeLessThan(8);
  // Two rows still fit with the hints.
  await expect(card(page).getByTestId("completion-hints")).toBeVisible();

  // Resizing the window refits the open card.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(async () => (await listFit(page)).height).toBe(248);
  await expect(card(page).getByTestId("completion-hints")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 400 });
  await expect.poll(async () => (await listFit(page)).height).toBeLessThanOrEqual(short.height);
  const tiny = await boxOf(page, "completion-card");
  // Under two rows' room the hints give their space to the rows.
  await expect(card(page).getByTestId("completion-hints")).toBeHidden();
  expect(tiny.y + tiny.height).toBeLessThanOrEqual(400 - 16 + 1);
});
