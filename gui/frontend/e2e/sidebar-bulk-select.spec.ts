import { expect, test, type Page } from "@playwright/test";
import { appPath, holdThreads, invocations, mockPost, mockUrl, resetMock, threadsOpenAsTabs } from "./fixtures";

/**
 * Dragging the sidebar's selection (docs/notes/sidebar-bulk-select.md), what only a browser shows:
 * a three-row selection dragged into a pane (its tabs land in list order), onto a pane's edge (one
 * split holds them all), onto a space tab, and a selection or a single row onto the Archived and
 * Snoozed headers; the ghost's count. Selecting (cmd- and shift-click), the bulk menu, which
 * command runs with which ids and the plans of each drop are vitest's
 * (sidebar/shell/ShellSidebarList.test.tsx, lib/sidebarSelection.test.ts, shell/drag/groupDrop.test.ts).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const pane = (id: string, tabs: Tab[]): Node => ({ t: "pane", id, tabs, active: tabs[0]?.id ?? "" });

/** Main holds `main`; with `review`, a second space Review (the window stays in Main). */
async function seed(main: Node, review: Node | null = null): Promise<void> {
  const spaces = [{ id: "sp-main", name: "Main", root: main, focus: "p-1", mru: [], drafts: [] }, ...(review ? [{ id: "sp-review", name: "Review", root: review, focus: "p-r", mru: [], drafts: [] }] : [])];
  const state = { v: 1, spaces, current_space: "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

type Stored = { spaces: { id: string; root: Node | null }[]; threads?: Record<string, { space?: string }> };
async function stored(): Promise<Stored> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return ((await res.json()) as { state: Stored }).state;
}

/** A space's stored tree by the threads its tabs show: `row([s-1] [s-t-1,s-t-2])`. */
async function outline(space: string): Promise<string> {
  const draw = (n: Node | null): string => (!n ? "" : n.t === "pane" ? `[${n.tabs.map((t) => String(t.thread ?? t.kind)).join(",")}]` : `${n.dir}(${n.kids.map(draw).join(" ")})`);
  return draw((await stored()).spaces.find((s) => s.id === space)?.root ?? null);
}

// Three idle threads the mock's clock leaves alone (s-t-1 "Thread 1" …), so the rows hold still.
const IDS = ["s-t-1", "s-t-2", "s-t-3"];

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await expect(page.locator("[data-shell-list]")).toBeVisible();
  for (const id of IDS) await expect(row(page, id)).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

const row = (page: Page, id: string) => page.locator(`[data-row-key="s:${id}"]`);
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));

/** The thread rows in the order the list shows them. */
async function shownOrder(page: Page, ids: readonly string[]): Promise<string[]> {
  const tops = await Promise.all(ids.map(async (id) => [id, (await row(page, id).boundingBox())?.y ?? 0] as const));
  return [...tops].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** Cmd-clicks the first, shift-clicks the last: the three rows between them are selected. */
async function selectThree(page: Page): Promise<string[]> {
  const order = await shownOrder(page, IDS);
  await row(page, order[0] ?? "").click({ modifiers: ["Meta"] });
  await row(page, order[2] ?? "").click({ modifiers: ["Shift"] });
  for (const id of IDS) await expect(row(page, id)).toHaveAttribute("data-picked", "true");
  return order;
}

/** Presses on a row and moves to `to`, holding the button. */
async function lift(page: Page, id: string, to: { x: number; y: number }): Promise<void> {
  await settled(page);
  const from = await box(page, `[data-row-key="s:${id}"]`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

test.beforeEach(async () => {
  await resetMock();
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
  await holdThreads("s-6");
  await mockPost("threads?project=repo-cf&count=3&status=idle");
});

test("a three-row selection dragged into a pane opens each there, in list order, after its tabs; the ghost counts them", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  const order = await selectThree(page);
  const p = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
  await lift(page, order[1] ?? "", { x: p.x + p.width / 2, y: p.y + p.height / 2 });
  await expect(page.getByTestId("shell-drag-count")).toHaveText("3");
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "pane");
  await page.mouse.up();
  await expect.poll(() => outline("sp-main")).toBe(`[s-1,${order.join(",")}]`);
  await expect(page.locator("[data-picked]")).toHaveCount(0);
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
});

test("dropped on a pane's edge, the split is made once and holds every one of them", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  const order = await selectThree(page);
  const p = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
  await lift(page, order[0] ?? "", { x: p.x + p.width - 30, y: p.y + p.height / 2 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "edge");
  await page.mouse.up();
  await expect.poll(() => outline("sp-main")).toBe(`row([s-1] [${order.join(",")}])`);
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  const splits = (await invocations()).filter((i) => i.args.split !== undefined);
  expect(splits).toHaveLength(1);
});

test("dropped on a space tab, every one moves there and the window stays", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]), pane("p-r", [thread("s-2")]));
  await openShell(page);
  await selectThree(page);
  const tab = await box(page, '[data-testid="space-tab"][data-space-id="sp-review"]');
  await lift(page, IDS[1] ?? "", { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 });
  await expect(page.locator('[data-testid="space-tab"][data-space-id="sp-review"]')).toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
  await expect
    .poll(async () => {
      const t = (await stored()).threads ?? {};
      return IDS.map((id) => t[id]?.space ?? "");
    })
    .toEqual(["sp-review", "sp-review", "sp-review"]);
  for (const id of IDS) await expect(row(page, id)).toHaveCount(0);
  await expect(page.locator('[data-testid="space-tab"][data-current]')).toHaveAttribute("data-space-id", "sp-main");
});

test("the Archived header, collapsed, archives a dragged selection; the Snoozed header saves a single row for later", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  await expect(page.getByTestId("archived-header")).toHaveAttribute("aria-expanded", "false");
  const order = await selectThree(page);
  const archived = await box(page, '[data-drop-section="archived"]');
  await lift(page, order[2] ?? "", { x: archived.x + archived.width / 2, y: archived.y + archived.height / 2 });
  await expect(page.locator('[data-drop-section="archived"]')).toHaveAttribute("data-drop-target", "true");
  // Nothing in the grid takes it while it is over the header.
  await expect(page.getByTestId("shell-drop-preview")).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.args.ids)).toEqual([order.join(",")]);
  for (const id of IDS) await expect(row(page, id)).toHaveCount(0);

  // A single row (s-3, idle) onto Snoozed: saved for later.
  const snoozed = await box(page, '[data-drop-section="snoozed"]');
  await lift(page, "s-3", { x: snoozed.x + snoozed.width / 2, y: snoozed.y + snoozed.height / 2 });
  await expect(page.locator('[data-drop-section="snoozed"]')).toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.snooze").map((i) => i.args)).toEqual([expect.objectContaining({ ids: "s-3", save: "true" })]);
});

test("an archived row over the Archived header is no target", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  await page.getByTestId("archived-header").click();
  const header = await box(page, '[data-drop-section="archived"]');
  await lift(page, "s-7", { x: header.x + header.width / 2, y: header.y + header.height / 2 });
  await expect(page.locator('[data-drop-section="archived"]')).not.toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
  expect((await invocations()).filter((i) => i.name === "thread.archive")).toEqual([]);
});

/** SHOTS=<dir>: the selection, the bulk menu, the ghost with its count over a pane, a header lit as a drop target; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`bulk select screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed(pane("p-1", [thread("s-1")]));
    await openShell(page);
    // The open thread's row (s-1's) beside the selection, so both looks show.
    await row(page, "s-4").click();
    const order = await selectThree(page);
    await page.mouse.move(700, 20);
    await settled(page);
    await page.screenshot({ path: at("bulk-selection") });
    await row(page, order[1] ?? "").click({ button: "right" });
    await expect(page.getByTestId("bulk-menu")).toBeVisible();
    await settled(page);
    await page.screenshot({ path: at("bulk-menu") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bulk-menu")).toHaveCount(0);
    const p = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
    await lift(page, order[1] ?? "", { x: p.x + p.width / 2, y: p.y + p.height / 2 });
    await expect(page.getByTestId("shell-drag-count")).toHaveText("3");
    await settled(page);
    await page.screenshot({ path: at("bulk-drag-ghost") });
    const archived = await box(page, '[data-drop-section="archived"]');
    await page.mouse.move(archived.x + archived.width / 2, archived.y + archived.height / 2, { steps: 8 });
    await expect(page.locator('[data-drop-section="archived"]')).toHaveAttribute("data-drop-target", "true");
    await settled(page);
    await page.screenshot({ path: at("bulk-header-target") });
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });
}
