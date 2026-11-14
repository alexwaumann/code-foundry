import { expect, test, type Page } from "@playwright/test";
import { appPath, invocations, mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * The shell's sidebar (docs/notes/shell-16-sidebar.md), what only a browser shows: a title
 * wrapping to two lines at full width and cut after them, the hover controls taking the status's
 * place without moving the title, and a row dragged into the pane grid. Which rows, lines and
 * verbs are vitest's (lib/shellSections.test.ts, sidebar/shell/ShellSidebarList.test.tsx).
 * SHOTS=<dir> for the PR's screenshots (WebKit, at the sidebar's narrowest width, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };
type Draft = { id: string; label: string; params: Record<string, string> };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });

/** One space, "Main", with that tree and drafts; `elsewhere` threads live in a second space, "Review". */
async function seed(root: Node | null, focus: string, drafts: Draft[] = [], elsewhere: string[] = []): Promise<void> {
  const spaces = [{ id: "sp-main", name: "Main", root, focus, mru: [], drafts }, ...(elsewhere.length > 0 ? [{ id: "sp-review", name: "Review", root: null, focus: "", mru: [], drafts: [] }] : [])];
  const threads = Object.fromEntries(elsewhere.map((id) => [id, { space: "sp-review" }]));
  const state = { v: 1, spaces, current_space: "sp-main", default_space: "sp-main", threads };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function storedRoot(): Promise<Node | null> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: { spaces: { root: Node | null }[] } }).state.spaces[0]?.root ?? null;
}

/** The stored tree by the threads its tabs show: `row([s-1] [s-sb-trip])`. */
function outline(n: Node | null): string {
  if (!n) return "";
  if (n.t === "pane") return `[${n.tabs.map((t) => String(t.thread ?? t.kind)).join(",")}]`;
  return `${n.dir}(${n.kids.map(outline).join(" ")})`;
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await expect(page.locator("[data-shell-list]")).toBeVisible();
}

const rowEl = (page: Page, id: string) => page.locator(`[data-row-key="s:${id}"]`);

type Box = { x: number; y: number; width: number; height: number };
async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

/** Wait out finite animations (a menu's or tooltip's fade); a spinner runs for ever. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test.beforeEach(async () => {
  await resetMock();
  await mockPost("shell-sidebar");
});

test("a title wraps at the row's full width and is cut after two lines", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]), "p-1");
  await openShell(page);
  const long = rowEl(page, "s-sb-flaky");
  await expect(long).toBeVisible();
  const name = long.getByTestId("thread-name");
  const lines = await name.evaluate((el) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return { lh, h: el.getBoundingClientRect().height, clipped: el.scrollHeight > el.clientHeight + 1 };
  });
  // Two lines, cut: more text than fits.
  expect(lines.h).toBeCloseTo(2 * lines.lh, 0);
  expect(lines.clipped).toBe(true);
  // At full width: the row's content box, nothing beside it.
  const row = await box(page, '[data-row-key="s:s-sb-flaky"]');
  const title = await name.boundingBox();
  expect(title?.width).toBeGreaterThan(row.width - 2 * 8 - 1);
  // A short title is one line.
  const short = await rowEl(page, "s-sb-trip").getByTestId("thread-name").evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(Math.round(short)).toBe(1);
});

test("on hover the snooze and archive controls take the status's slot in line 1; the title does not move", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]), "p-1");
  await openShell(page);
  const row = rowEl(page, "s-sb-flaky");
  await page.mouse.move(700, 450);
  const before = await row.getByTestId("thread-name").boundingBox();
  const status = await row.getByTestId("row-line-1").boundingBox();
  await row.hover();
  const actions = row.getByTestId("row-actions");
  await expect(actions).toHaveCSS("opacity", "1");
  const after = await row.getByTestId("thread-name").boundingBox();
  expect(after).toEqual(before);
  const a = await actions.boundingBox();
  // Inside line 1, at its right end.
  expect(a && status && a.y >= status.y - 3 && a.y + a.height <= status.y + status.height + 3).toBe(true);
  expect(a && status && Math.abs(a.x + a.width - (status.x + status.width)) <= 1).toBe(true);
});

/** Presses on a sidebar row and moves to `to`, holding the button; the ghost names the thread. */
async function liftRow(page: Page, id: string, name: string, to: { x: number; y: number }): Promise<void> {
  await page.locator(`[data-row-key="s:${id}"]`).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  const from = await box(page, `[data-row-key="s:${id}"]`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toContainText(name);
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

test("a row dragged onto a pane's edge opens its thread in a new pane there", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]), "p-1");
  await openShell(page);
  const p1 = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
  await liftRow(page, "s-sb-trip", "Plan the spring trip", { x: p1.x + p1.width - 30, y: p1.y + p1.height / 2 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "edge");
  await page.mouse.up();
  await expect.poll(async () => outline(await storedRoot())).toBe("row([s-1] [s-sb-trip])");
  // One command, with the place: the drop cannot stop halfway (shell-review-fixes-daemon.md).
  expect((await invocations()).filter((i) => i.name === "thread.open" || i.name === "tab.move").map((i) => i.name)).toEqual(["thread.open"]);
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
});

test("a row dragged into a strip opens its thread at the place the bar shows", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]), "p-1");
  await openShell(page);
  // In the strip (the pane's top 44px), left of the first tab's centre and clear of the grid's
  // outer band (10px in from its left edge).
  const p1 = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
  await liftRow(page, "s-sb-charts", "Compare three charting libraries", { x: p1.x + 30, y: p1.y + 22 });
  await expect(page.getByTestId("shell-drop-bar")).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => outline(await storedRoot())).toBe("[s-sb-charts,s-1]");
});

test("a row dropped on a rail opens its thread in that folded pane", async ({ page }) => {
  // Two panes; at a 520px grid (less than the two minimums) the unfocused left one folds to a rail (shell-19-rails-fullscreen.md).
  const root: Node = { t: "split", id: "s-r", dir: "row", kids: [pane("p-l", [{ id: "t-prs", kind: "prs", title: "Pull Requests" }]), pane("p-m", [thread("s-1")])], sizes: [0.5, 0.5] };
  await seed(root, "p-m");
  await openShell(page);
  const grid = await box(page, '[data-testid="shell-grid"]');
  await page.setViewportSize({ width: Math.round(1400 - grid.width + 520), height: 900 });
  const rail = page.locator('[data-testid="shell-rail"][data-pane-id="p-l"]');
  await expect(rail).toBeVisible();
  const to = await box(page, '[data-testid="shell-rail"][data-pane-id="p-l"]');
  await liftRow(page, "s-sb-trip", "Plan the spring trip", { x: to.x + to.width / 2, y: to.y + to.height / 2 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "pane");
  await page.mouse.up();
  await expect.poll(async () => outline(await storedRoot())).toBe("row([prs,s-sb-trip] [s-1])");
  expect((await invocations()).find((i) => i.name === "thread.open")?.args).toMatchObject({ id: "s-sb-trip", pane: "p-l" });
});

test("typing in a composer tab makes a draft: listed, kept through closing its tab and a reload, cleared when emptied", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1"), { id: "t-c", kind: "compose", params: { project: "repo-cf" } }], "t-c"), "p-1");
  await openShell(page);
  const input = page.locator('[data-pane-id="p-1"]').getByTestId("composer-input");
  await input.click();
  await page.keyboard.type("Write up the shell's sidebar");
  const row = page.locator('[data-row-kind="draft"]');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("draft-label")).toHaveText("Write up the shell's sidebar");
  // Its tab is named by its label.
  await expect(page.locator('[data-tab-id="t-c"]')).toContainText("Write up the shell's sidebar");
  // Closing its tab keeps it; a reload keeps its text.
  await page.locator('[data-tab-id="t-c"]').hover();
  await page.keyboard.press("Meta+w");
  await expect(page.locator('[data-tab-id="t-c"]')).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-shell-list]")).toBeVisible();
  await page.locator('[data-row-kind="draft"]').click();
  const reopened = page.getByTestId("composer-prompt");
  await expect(reopened).toHaveAttribute("data-value", "Write up the shell's sidebar");
  // Emptied, it is the space's empty composer again and its row goes.
  await page.getByTestId("composer-input").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await expect(page.locator('[data-row-kind="draft"]')).toHaveCount(0);
  const names = (await invocations()).filter((i) => i.name.startsWith("composer.draft.")).map((i) => i.name);
  expect(names[0]).toBe("composer.draft.start");
  expect(names).toContain("composer.draft.open");
  expect(names.at(-1)).toBe("composer.draft.clear");
});

test("sending from a draft turns its tab into the thread's and its row goes", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1"), { id: "t-c", kind: "compose", params: { project: "repo-cf" } }], "t-c"), "p-1");
  await openShell(page);
  await page.locator('[data-pane-id="p-1"]').getByTestId("composer-input").click();
  await page.keyboard.type("Tidy the README");
  await expect(page.locator('[data-row-kind="draft"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.new")?.args.compose).toBe("t-c");
  await expect(page.locator('[data-row-kind="draft"]')).toHaveCount(0);
  await expect(page.locator('[data-pane-id="p-1"] [data-testid="shell-tab"][data-kind="thread"][data-active="true"]')).toHaveCount(1);
});

test("a draft sent with an attachment becomes the thread, even when another draft took the focus while the file uploaded", async ({ page }) => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await seed(
    { t: "split", id: "s-r", dir: "row", sizes: [0.5, 0.5], kids: [pane("p-a", [{ id: "t-a", kind: "compose", params: { draft: "d-a" } }]), pane("p-b", [{ id: "t-b", kind: "compose", params: { draft: "d-b" } }])] },
    "p-a",
    [
      { id: "d-a", label: "Ship it", params: { project: "repo-cf" } },
      { id: "d-b", label: "Keep me", params: { project: "repo-cf" } },
    ],
  );
  await openShell(page);
  const paneA = page.locator('[data-pane-id="p-a"]');
  const paneB = page.locator('[data-pane-id="p-b"]');
  await paneB.getByTestId("composer-input").click();
  await page.keyboard.type("Keep me");
  await paneA.getByTestId("composer-input").click();
  await page.keyboard.type("Ship it");
  await paneA.getByTestId("composer-file-input").setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: PNG }]);
  await mockPost("attachments/hold?on=true");
  await paneA.getByTestId("composer-input").click();
  await page.keyboard.press("Enter");
  // While the file uploads, the user moves to the other draft and types there.
  await paneB.getByTestId("composer-input").click();
  await expect(paneB).toHaveAttribute("data-focused", "true");
  await page.keyboard.type(" too");
  await mockPost("attachments/hold?on=false");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.new")?.args.compose).toBe("t-a");
  await expect(paneA.locator('[data-testid="shell-tab"][data-kind="thread"]')).toHaveCount(1);
  await expect(paneB.locator('[data-testid="shell-tab"][data-kind="compose"]')).toHaveCount(1);
  await expect(paneB.getByTestId("composer-prompt")).toHaveAttribute("data-value", "Keep me too");
  await expect(page.locator('[data-row-kind="draft"]')).toHaveCount(1);
});

/** SHOTS=<dir>: the whole sidebar, a hovered row, rows without a project, drafts, the scope button both ways; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shell sidebar screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    // Port renderer (s-2) asks from the other space: "This space" leaves it out.
    await seed(
      pane("p-1", [thread("s-1"), { id: "t-c", kind: "compose", params: { draft: "d-notes" } }], "t-c"),
      "p-1",
      [
        { id: "d-notes", label: "Write up the shell's sidebar for the release notes, every section and what moved", params: { project: "repo-cf" } },
        { id: "d-empty", label: "", params: {} },
      ],
      ["s-2"],
    );
    await openShell(page);
    await page.setViewportSize({ width: 1400, height: 1100 });
    await expect(rowEl(page, "s-sb-flaky")).toBeVisible();
    // The sidebar with the top bar's part above it (the bar spans the window; PR 15).
    const sidebar = {
      screenshot: async (o: { path: string }) => {
        const b = await box(page, '[data-testid="sidebar"]');
        await page.screenshot({ path: o.path, clip: { x: 0, y: 0, width: b.x + b.width + 120, height: b.y + b.height } });
      },
    };
    await page.mouse.move(800, 600);
    await still(page);
    await sidebar.screenshot({ path: at("sidebar") });

    await rowEl(page, "s-sb-flaky").hover();
    await expect(rowEl(page, "s-sb-flaky").getByTestId("row-actions")).toHaveCSS("opacity", "1");
    await still(page);
    await sidebar.screenshot({ path: at("sidebar-hover") });

    // Rows without a project, with and without a third line.
    await page.mouse.move(800, 600);
    const clipOf = async (ids: string[]) => {
      const boxes = await Promise.all(ids.map((id) => box(page, `[data-row-key="${id}"]`)));
      const x = Math.min(...boxes.map((b) => b.x)) - 4;
      const y = Math.min(...boxes.map((b) => b.y)) - 4;
      const r = Math.max(...boxes.map((b) => b.x + b.width)) + 4;
      const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 4;
      return { x, y, width: r - x, height: bottom - y };
    };
    await still(page);
    await page.screenshot({ path: at("no-project-rows"), clip: await clipOf(["s:s-sb-trip", "s:s-sb-charts"]) });
    await rowEl(page, "s-sb-notes").scrollIntoViewIfNeeded();
    await page.locator('[data-row-key="d:d-notes"]').hover();
    await still(page);
    await page.screenshot({ path: at("drafts"), clip: await clipOf(["h:active", "d:d-notes", "d:d-empty"]) });

    await page.mouse.move(800, 600);
    const header = page.locator('[data-row-key="h:needs"]');
    await still(page);
    await header.screenshot({ path: at("scope-all") });
    await page.getByTestId("needs-scope").click();
    await expect(page.getByTestId("needs-scope")).toHaveAttribute("data-scope", "space");
    await page.mouse.move(800, 600);
    await still(page);
    await expect(page.locator('[data-row-key="s:s-2"]')).toHaveCount(0);
    await header.screenshot({ path: at("scope-space") });
    await sidebar.screenshot({ path: at("sidebar-this-space") });

    // The row's menu: Open ▸ and Move to space ▸ (the second space, Review, holds Port renderer).
    await page.getByTestId("needs-scope").click();
    await rowEl(page, "s-sb-trip").click({ button: "right" });
    await page.getByTestId("row-menu-move-to-space").hover();
    await expect(page.getByTestId("row-menu-move-to-space-spaces")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("row-menu-move"), clip: { x: 0, y: 0, width: 760, height: 1100 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });
}
