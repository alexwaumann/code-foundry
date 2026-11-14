import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * Linked tabs in the window shell (docs/notes/shell-12-linked-tabs.md), against the mock's layout
 * seeded per test. What only a browser shows: a submenu reached by the pointer and by the
 * keyboard, and the thread info card floating over a narrow pane's conversation until a press
 * back in it. The menus' contents, the row's text and which verb each item runs are vitest's
 * (components/shell/linkedTabs.test.tsx, shell/linked.test.ts). SHOTS=<dir> for the PR's
 * screenshots (WebKit, 1400x900, dark and light).
 */

type Node = { t: "pane"; id: string; tabs: Record<string, unknown>[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const WT = "/Users/dev/src/code-foundry";
const SLUG = "alexwaumann/code-foundry";
const thread = (id: string) => ({ id: `t-${id}`, kind: "thread", thread: id });
const diff = { id: "t-diff", kind: "diff", thread: "s-1", params: { project: "repo-cf", worktree: WT, own: "1" }, title: "Diff" };
const pr = { id: "t-pr", kind: "pullrequest", thread: "s-1", params: { slug: SLUG, number: "1853" }, title: "#1853" };
// s-1's shell in the mock (mock/world.ts t-s1-shell); its facts are set per test.
const term = { id: "t-term", kind: "terminal", thread: "s-1", params: { terminal: "t-s1-shell" } };
const pane = (id: string, tabs: Record<string, unknown>[], active = String(tabs[0]?.id)): Node => ({ t: "pane", id, tabs, active });
const two = (left: Node, right: Node, sizes = [0.55, 0.45]): Node => ({ t: "split", id: "s-r", dir: "row", kids: [left, right], sizes });

/** Puts a layout (internal/layout's JSON) in the mock as one commit. */
async function seed(root: Node | null, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function linkPr(): Promise<void> {
  const res = await fetch(`${mockUrl}/__mock/link-pr?thread=s-1&slug=${SLUG}&number=1853`, { method: "POST" });
  expect(res.ok).toBe(true);
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

const paneEl = (page: Page, id: string) => page.locator(`[data-testid="shell-pane"][data-pane-id="${id}"]`);

async function activeTab(page: Page, paneId: string): Promise<string | null> {
  return paneEl(page, paneId).locator('[data-testid="shell-tab"][data-active]').getAttribute("data-tab-id");
}

/**
 * Moves the pointer onto a submenu's trigger as a hand does, in two moves, the second leftwards.
 * Radix ignores the pointer moving from an open submenu's trigger toward that submenu
 * (rightwards, its grace area), judging a move by the direction of the one before it: the first
 * move lands on the trigger, the second (leftwards) is one it never ignores.
 */
async function hoverSub(page: Page, trigger: string, sub: string): Promise<void> {
  await page.getByTestId(trigger).hover({ position: { x: 40, y: 8 } });
  await page.getByTestId(trigger).hover({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId(sub)).toBeVisible();
}

/** The page's running animations (a menu's fade and zoom in) have finished: a screenshot shows the menu whole. */
async function still(page: Page): Promise<void> {
  // Finite ones only: a spinner runs for ever.
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
});

test("the + menu's thread submenu opens on hover, and the whole path works from the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(two(pane("p-1", [thread("s-1"), thread("s-3")]), pane("p-2", [{ id: "t-prs", kind: "prs", title: "Pull Requests" }, diff])), "p-1");
  await openShell(page);

  // The pointer: hovering the thread's item opens its surfaces; the open diff is focused where it is.
  await paneEl(page, "p-1").getByTestId("pane-plus").click();
  await page.getByTestId("plus-thread").hover();
  const sub = page.getByTestId("plus-thread-surfaces");
  await expect(sub).toBeVisible();
  await sub.locator('[data-kind="diff"]').click();
  await expect(sub).toBeHidden();
  await expect.poll(() => activeTab(page, "p-2")).toBe("t-diff");
  await expect(paneEl(page, "p-2")).toHaveAttribute("data-focused", "true");

  // The keyboard: Enter on "+", down to the thread, right into its submenu, Enter on the diff.
  await paneEl(page, "p-1").getByRole("tab", { name: "Refactor sidebar tree" }).click();
  await expect(paneEl(page, "p-1")).toHaveAttribute("data-focused", "true");
  await paneEl(page, "p-2").locator('[data-tab-id="t-prs"] [role="tab"]').click();
  await paneEl(page, "p-1").getByTestId("pane-plus").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pane-plus-menu")).toBeVisible();
  // Opened from the keyboard, the first item (the thread) has the focus.
  await expect(page.getByTestId("plus-thread")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(sub).toBeVisible();
  await expect(sub.locator('[data-kind="diff"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => activeTab(page, "p-2")).toBe("t-diff");
});

test("the + is not the pane's drag grip: a press and move there opens the menu, the strip's free space drags the pane", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(two(pane("p-1", [thread("s-1")]), pane("p-2", [diff])), "p-1");
  await openShell(page);
  const ghost = page.getByTestId("shell-drag-ghost");
  const twoFrames = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              r();
            });
          });
        }),
    );
  const plus = await paneEl(page, "p-1").getByTestId("pane-plus").boundingBox();
  const strip = await paneEl(page, "p-1").getByTestId("shell-tab-strip").boundingBox();
  if (!plus || !strip) throw new Error("no + or strip");

  // From the "+": well past dnd-kit's 4px activation, and no drag starts; the menu is open.
  await page.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2);
  await page.mouse.down();
  await page.mouse.move(plus.x + plus.width / 2 + 80, plus.y + 120, { steps: 6 });
  await twoFrames();
  await expect(page.getByTestId("pane-plus-menu")).toBeVisible();
  await expect(ghost).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pane-plus-menu")).toBeHidden();

  // The same move from the strip's free space, right of the "+", lifts the pane (and Escape puts it back).
  await page.mouse.move(strip.x + strip.width - 30, strip.y + strip.height / 2);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width - 30 + 80, strip.y + 120, { steps: 6 });
  await expect(ghost).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
});

test("the header's submenus follow the pointer, Open to Move to space", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(two(pane("p-1", [thread("s-1")]), pane("p-2", [diff])), "p-1");
  await openShell(page);
  await paneEl(page, "p-1").getByTestId("thread-header-menu-trigger").click();
  await page.getByTestId("menu-open").hover();
  await expect(page.getByTestId("menu-open-surfaces")).toBeVisible();
  await hoverSub(page, "menu-move-to-space", "menu-move-to-space-spaces");
  await expect(page.getByTestId("menu-open-surfaces")).toBeHidden();
  await expect(page.getByTestId("move-to-space-item")).toHaveAttribute("data-disabled", "");
});

test("thread info floats over a narrow pane's conversation until a press back in it; a wide pane keeps the card inline", async ({ page }) => {
  // The card takes 320px beside 480px of conversation: the right pane has room, the left none.
  await page.setViewportSize({ width: 1600, height: 900 });
  await seed(two(pane("p-1", [thread("s-1")]), pane("p-2", [thread("s-3")]), [0.28, 0.72]), "p-1");
  await openShell(page);
  const narrow = paneEl(page, "p-1");
  await narrow.getByTestId("thread-info-toggle").click();
  await expect(narrow.getByTestId("thread-info-overlay")).toBeVisible();
  await expect(narrow.getByTestId("thread-info-toggle")).toHaveAttribute("aria-pressed", "true");
  // The card is the window's preference: the wide pane shows it beside its conversation, never floating.
  const wide = paneEl(page, "p-2");
  await expect(wide.getByTestId("thread-info-card")).toBeVisible();
  await expect(wide.getByTestId("thread-info-overlay")).toHaveCount(0);
  // A press back in the narrow conversation dismisses its overlay; the wide pane's card stays.
  await narrow.getByTestId("thread-pane-body").click({ position: { x: 20, y: 200 } });
  await expect(narrow.getByTestId("thread-info-overlay")).toBeHidden();
  await expect(narrow.getByTestId("thread-info-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(wide.getByTestId("thread-info-card")).toBeVisible();
});

/** SHOTS=<dir>: the row, the header's menu and its submenus, the + menu with and without a thread, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`linked tab screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await linkPr();
    // The linked terminal runs make dev and has left its thread's directory: its row shows the hint.
    await mockPost("terminal/facts?id=t-s1-shell&foreground=make%20dev&liveCwd=/tmp");
    // s-2 waits on a permission: its tab's icon has the attention dot.
    await seed(two(pane("p-1", [thread("s-1"), thread("s-2")]), pane("p-2", [diff, pr, term, { id: "t-prs", kind: "prs", title: "Pull Requests" }])), "p-1");
    await openShell(page);
    await expect(paneEl(page, "p-2").getByTestId("shell-linked-row")).toBeVisible();
    await expect(paneEl(page, "p-1").getByTestId("shell-tab-attention")).toBeVisible();
    await page.mouse.move(700, 880);
    await still(page);
    await page.screenshot({ path: at("linked-row") });

    await paneEl(page, "p-1").getByTestId("thread-header-menu-trigger").click();
    await page.getByTestId("menu-open").hover();
    await expect(page.getByTestId("menu-open-surfaces")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("header-menu-open") });
    await hoverSub(page, "menu-move-to-space", "menu-move-to-space-spaces");
    await still(page);
    await page.screenshot({ path: at("header-menu-move") });
    await hoverSub(page, "menu-snooze", "menu-snooze-presets");
    await still(page);
    await page.screenshot({ path: at("header-menu-snooze") });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await paneEl(page, "p-1").getByTestId("pane-plus").click();
    await page.getByTestId("plus-thread").hover();
    await expect(page.getByTestId("plus-thread-surfaces")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("plus-menu-thread") });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await paneEl(page, "p-2").locator('[data-tab-id="t-prs"] [role="tab"]').click();
    await paneEl(page, "p-2").getByTestId("pane-plus").click();
    await expect(page.getByTestId("pane-plus-menu")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("plus-menu-no-thread") });
    await page.keyboard.press("Escape");

    // The linked terminal's row: "Terminal of ● thread" and, at its right, the directory hint.
    await paneEl(page, "p-2").locator('[data-tab-id="t-term"] [role="tab"]').click();
    await expect(paneEl(page, "p-2").getByTestId("terminal-cwd-hint")).toBeVisible();
    await page.mouse.move(700, 880);
    await still(page);
    await page.screenshot({ path: at("linked-row-terminal") });

    // The dormant row: the diff's thread is not open in the space.
    await seed(two(pane("p-1", [thread("s-3")]), pane("p-2", [diff])), "p-1");
    await expect(paneEl(page, "p-2").getByTestId("shell-linked-row")).not.toHaveAttribute("data-live", "");
    await page.mouse.move(700, 880);
    await still(page);
    await page.screenshot({ path: at("linked-row-dormant") });
  });
}
