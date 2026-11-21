import { expect, test, type Locator, type Page } from "@playwright/test";
import { appPath, invocations, mockPost, mockUrl, openStreams, resetMock, threadsOpenAsTabs } from "./fixtures";

/**
 * The Needs-you inbox (docs/notes/shell-17-needs-you.md), what only a browser shows: the pointer
 * moving from a row into its hover card, a long command growing the card to its maximum and
 * scrolling inside it, the one-line strip in a short pane, and the popup holding one WatchThread
 * (shared with a pane) only while open. What the card shows and which verb each control runs are
 * vitest's (components/needs/*.test.tsx, lib/needsAsk.test.ts).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string };

const threadTab = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const pane = (id: string, tabs: Tab[], active = tabs[0]?.id ?? ""): Node => ({ t: "pane", id, tabs, active });

/** One space, "Main", with that tree. */
async function seed(root: Node | null, focus: string): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [], drafts: [] }], current_space: "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function openShell(page: Page, height = 900): Promise<void> {
  await page.setViewportSize({ width: 1400, height });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await expect(page.locator("[data-shell-list]")).toBeVisible();
}

const rowEl = (page: Page, id: string) => page.locator(`[data-row-key="s:${id}"]`);
const card = (page: Page) => page.getByTestId("needs-card");
const watches = async () => (await openStreams())["ThreadService/WatchThread"] ?? 0;

async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Wait out finite animations (a card's fade); a spinner runs for ever. */
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
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
  await mockPost("needs-you");
});

test("the pointer goes from a row into its card, from the title or from the ask's slot, and acts there", async ({ page }) => {
  await seed(pane("p-1", [threadTab("s-1")]), "p-1");
  await openShell(page);
  const row = rowEl(page, "s-ny-notes");
  // From the title, across the gap into the card.
  const title = row.getByTestId("thread-name");
  await title.hover();
  await expect(card(page)).toBeVisible();
  const go = card(page).getByTestId("needs-card-go");
  const to = await centre(go);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(card(page)).toBeVisible();
  await expect(go).toBeVisible();
  // Away, then from line 1's right end (where the other rows' hover controls sit: the ask's kind).
  await page.mouse.move(900, 700);
  await expect(card(page)).toHaveCount(0);
  await row.getByTestId("row-ask").hover();
  await expect(card(page)).toBeVisible();
  const deny = card(page).getByTestId("needs-card-deny");
  const at = await centre(deny);
  await page.mouse.move(at.x, at.y, { steps: 12 });
  await expect(card(page)).toBeVisible();
  // Allow, from the card: the thread leaves Needs you and the window stays where it was.
  await card(page).getByTestId("needs-card-allow").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.respond").map((i) => i.args)).toEqual([{ id: "s-ny-notes", request: "req-ask-s-ny-notes", decision: "allow" }]);
  await expect(rowEl(page, "s-ny-notes")).not.toHaveAttribute("data-section", "needs");
  await expect(page.locator('[data-pane-id="p-1"] [data-testid="shell-tab"][data-active="true"]')).toHaveAttribute("data-tab-id", "t-s-1");
});

test("a long command grows the card to its maximum width and height, then scrolls inside it", async ({ page }) => {
  await seed(null, "");
  // A short window: the card's maximum height is the window's less a margin.
  await openShell(page, 340);
  await rowEl(page, "s-ny-badge").getByTestId("thread-name").hover();
  await expect(card(page).getByTestId("needs-card-target")).toHaveAttribute("data-kind", "command");
  await still(page);
  const m = await card(page).evaluate((el) => {
    const box = el.querySelector<HTMLElement>('[data-testid="needs-card-target"]');
    return { width: el.getBoundingClientRect().width, height: el.clientHeight, scroll: el.scrollHeight, boxH: box?.clientHeight ?? 0, boxScroll: box?.scrollHeight ?? 0, vh: window.innerHeight };
  });
  expect(Math.round(m.width)).toBe(560);
  // At most the room the card has: the window less its 12px collision padding on each side.
  expect(m.height).toBeLessThanOrEqual(m.vh - 24);
  expect(m.scroll).toBeGreaterThan(m.height);
  // The command box is whole (today's 160px cap lifted): the card scrolls, not the box.
  expect(m.boxH).toBeGreaterThan(160);
  expect(m.boxScroll).toBe(m.boxH);
  // A wheel over the card scrolls it, with the pointer still in it.
  const c = await centre(card(page));
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => card(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(card(page)).toBeVisible();
});

test("a short pane shows the ask as one line above the composer, and the full card again with room", async ({ page }) => {
  await seed(pane("p-1", [threadTab("s-ny-badge")]), "p-1");
  await openShell(page);
  const p1 = page.locator('[data-pane-id="p-1"]');
  await expect(p1.getByTestId("thread-permission")).toBeVisible();
  await expect(p1.getByTestId("ask-strip")).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 520 });
  await expect(p1.getByTestId("ask-strip")).toBeVisible();
  await expect(p1.getByTestId("thread-prompts")).toHaveCount(0);
  // Its card on hover, the popup on a click.
  await p1.getByTestId("ask-strip").hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-anchor", "strip:p-1");
  await p1.getByTestId("ask-strip").click();
  await expect(page.getByTestId("needs-popup")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("needs-popup")).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(p1.getByTestId("thread-permission")).toBeVisible();
  await expect(p1.getByTestId("ask-strip")).toHaveCount(0);
});

test("the popup holds one WatchThread while open, shared with a pane showing the same thread", async ({ page }) => {
  await seed(pane("p-1", [threadTab("s-ny-badge")]), "p-1");
  await openShell(page);
  await expect.poll(watches).toBe(1);
  // Another thread's popup: a second stream, gone on close.
  await rowEl(page, "s-ny-port").getByTestId("thread-name").click();
  await expect(page.getByTestId("needs-popup")).toBeVisible();
  await expect(page.getByTestId("needs-popup").getByTestId("thread-question")).toBeVisible();
  await expect.poll(watches).toBe(2);
  await page.getByTestId("needs-popup-close").click();
  await expect(page.getByTestId("needs-popup")).toHaveCount(0);
  await expect.poll(watches).toBe(1);
  // The pane's own thread: the popup shares its stream.
  await rowEl(page, "s-ny-badge").getByTestId("thread-name").click();
  await expect(page.getByTestId("needs-popup").getByTestId("thread-permission")).toBeVisible();
  await expect.poll(watches).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("needs-popup")).toHaveCount(0);
  await expect.poll(watches).toBe(1);
});

test("in a 550x360 window (1100x720 at 200%) the card stays in the window and the popup's header is never covered", async ({ page }) => {
  await seed(pane("p-1", [threadTab("s-1")]), "p-1");
  await openShell(page);
  // A 1100x720 window at 200% zoom: 550x360 CSS px.
  await page.setViewportSize({ width: 550, height: 360 });
  await rowEl(page, "s-ny-badge").getByTestId("thread-name").hover();
  await expect(card(page)).toBeVisible();
  await still(page);
  // The room right of the sidebar is under the card's 320px minimum: it takes that room, not more.
  const box = await card(page).boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(550);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(360);
  // The popup: its thread's ask and composer are taller than its body; the header stays on top.
  await rowEl(page, "s-ny-badge").getByTestId("thread-name").click();
  await expect(page.getByTestId("needs-popup").getByTestId("thread-permission")).toBeVisible();
  await still(page);
  for (const id of ["needs-popup-close", "needs-popup-go"]) {
    const on = await page.getByTestId(id).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at !== null && el.contains(at);
    });
    expect(on, `${id} is under the pointer where it is drawn`).toBe(true);
  }
});

const MULTI = "s-ny-multi";
const req = (n: number) => `req-ask-${MULTI}${n === 1 ? "" : `-${String(n)}`}`;
const lines = (page: Page) => rowEl(page, MULTI).getByTestId("needs-line");
const stepperCount = (page: Page) => page.getByTestId("needs-stepper-count");

test("a thread with three requests: its row grows by its lines in the list, and the pointer goes from a line into that request's card", async ({ page }) => {
  await seed(pane("p-1", [threadTab("s-1")]), "p-1");
  await openShell(page);
  await expect(lines(page)).toHaveCount(3);
  // The taller row is measured: it holds its lines, and the next row starts below it.
  const row = await rowEl(page, MULTI).boundingBox();
  const last = await lines(page).nth(2).boundingBox();
  const next = await page.locator('[data-row-key="h:active"]').boundingBox();
  if (!row || !last || !next) throw new Error("no box");
  expect(last.y + last.height).toBeLessThanOrEqual(row.y + row.height);
  expect(next.y).toBeGreaterThanOrEqual(row.y + row.height);
  // The second line's card, not the row's: its command, reached across the gap.
  await lines(page).nth(1).hover();
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toHaveAttribute("data-request-id", req(2));
  await expect(card(page).getByTestId("needs-card-target")).toContainText("gh pr edit 482");
  const allow = card(page).getByTestId("needs-card-allow");
  const to = await centre(allow);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toHaveAttribute("data-request-id", req(2));
  // Back on the title: the row's card, on its oldest request, once the line's has gone.
  await rowEl(page, MULTI).getByTestId("thread-name").hover();
  await expect(page.locator(`[data-testid="needs-card"][data-anchor="sidebar:${MULTI}"]`)).toBeVisible();
  await expect(page.locator('[data-testid="needs-card"][data-request-id]')).toHaveCount(0);
  await lines(page).nth(1).hover();
  await expect(page.locator(`[data-testid="needs-card"][data-anchor="sidebar:${MULTI}"]`)).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-request-id", req(2));
  await card(page).getByTestId("needs-card-allow").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.respond").map((i) => i.args)).toEqual([{ id: MULTI, request: req(2), decision: "allow" }]);
  await expect(lines(page)).toHaveCount(2);
  // The press stayed in the card: no thread opened behind it.
  await expect(page.locator('[data-pane-id="p-1"] [data-testid="shell-tab"][data-active="true"]')).toHaveAttribute("data-tab-id", "t-s-1");
});

test("the popup's stepper: the arrow keys reach it from the ask, and an answer by key moves to the next request", async ({ page }) => {
  await seed(pane("p-1", [threadTab("s-1")]), "p-1");
  await openShell(page);
  await lines(page).nth(2).click();
  const popup = page.getByTestId("needs-popup");
  await expect(stepperCount(page)).toHaveText("3 of 3");
  await expect(popup.getByTestId("thread-question")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(stepperCount(page)).toHaveText("2 of 3");
  await expect(popup.getByTestId("thread-permission")).toBeFocused();
  await expect(popup.getByTestId("thread-prompts")).toHaveAttribute("data-count", "1");
  // In the deny reason the arrows move the caret.
  await page.keyboard.press("2");
  await expect(popup.getByTestId("thread-deny-reason")).toBeFocused();
  await page.keyboard.type("no");
  await page.keyboard.press("ArrowLeft");
  await expect(popup.getByTestId("thread-deny-reason")).toBeFocused();
  await expect(stepperCount(page)).toHaveText("2 of 3");
  await page.keyboard.press("Escape");
  await expect(popup).toBeVisible();
  // Allowed by its digit: the next one after it, the question.
  await popup.getByTestId("thread-permission").focus();
  await page.keyboard.press("1");
  await expect(stepperCount(page)).toHaveText("2 of 2");
  await expect(popup.getByTestId("thread-question")).toBeFocused();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.respond").map((i) => i.args)).toEqual([{ id: MULTI, request: req(2), decision: "allow" }]);
});

/** SHOTS=<dir>: the sidebar with a three-request thread and its popup's stepper, dark and light (the PR's before and after). */
for (const scheme of ["dark", "light"] as const) {
  test(`needs you line items screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed(pane("p-1", [threadTab("s-1")]), "p-1");
    await openShell(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(rowEl(page, MULTI)).toBeVisible();
    await page.mouse.move(900, 780);
    await still(page);
    await page.screenshot({ path: at("line-items-sidebar") });
    await rowEl(page, MULTI).getByTestId("thread-name").click();
    await expect(page.getByTestId("needs-popup").getByTestId("thread-permission").first()).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await still(page);
    await page.screenshot({ path: at("line-items-popup") });
  });
}

/** SHOTS=<dir>: the card and the popup at 200% in a 1100x720 window, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`needs you at 200% screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed(pane("p-1", [threadTab("s-1")]), "p-1");
    await openShell(page);
    await page.setViewportSize({ width: 550, height: 360 });
    await rowEl(page, "s-ny-badge").getByTestId("thread-name").hover();
    await expect(card(page)).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("needs-200-card") });
    await rowEl(page, "s-ny-badge").getByTestId("thread-name").click();
    await expect(page.getByTestId("needs-popup").getByTestId("thread-permission")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("needs-200-popup") });
    // The thread's pane behind it, narrower than a thread's minimum: its empty composer's placeholder.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("needs-popup")).toHaveCount(0);
    await page.mouse.move(1090, 710);
    await expect(card(page)).toHaveCount(0);
    await still(page);
    await page.screenshot({ path: at("composer-200") });
  });
}

/** SHOTS=<dir>: the hover card (a long command, a question), both popups, the strip; dark and light. The rail's card: sidebar-rail.spec.ts. */
for (const scheme of ["dark", "light"] as const) {
  test(`needs you screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed(pane("p-1", [threadTab("s-1")]), "p-1");
    await openShell(page);
    const window = async (name: string) => {
      await still(page);
      await page.screenshot({ path: at(name) });
    };

    await rowEl(page, "s-ny-badge").getByTestId("thread-name").hover();
    await expect(card(page).getByTestId("needs-card-context")).toBeVisible();
    await window("card-permission");

    await page.mouse.move(900, 800);
    await expect(card(page)).toHaveCount(0);
    await rowEl(page, "s-ny-port").getByTestId("thread-name").hover();
    await expect(card(page).getByTestId("needs-card-question")).toContainText("cell grid");
    await window("card-question");

    // The permission's popup, a reason being typed for Deny.
    await rowEl(page, "s-ny-badge").getByTestId("thread-name").click();
    const popup = page.getByTestId("needs-popup");
    await expect(popup.getByTestId("thread-permission")).toBeFocused();
    await page.keyboard.press("2");
    await page.keyboard.type("Don't query every PR: read the head SHAs from the poller's last snapshot.");
    await window("popup-permission-deny");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);

    await page.mouse.move(900, 800);
    await rowEl(page, "s-ny-port").getByTestId("thread-name").click();
    await expect(popup.getByTestId("thread-question")).toBeFocused();
    await page.keyboard.press("1");
    await window("popup-question");
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);

    // A short pane: the strip, and its card.
    await seed(pane("p-1", [threadTab("s-ny-badge")]), "p-1");
    await page.setViewportSize({ width: 1400, height: 520 });
    const strip = page.locator('[data-pane-id="p-1"]').getByTestId("ask-strip");
    await expect(strip).toBeVisible();
    await page.mouse.move(900, 100);
    await window("strip");
    await strip.hover();
    await expect(card(page)).toBeVisible();
    await window("strip-card");
  });
}
