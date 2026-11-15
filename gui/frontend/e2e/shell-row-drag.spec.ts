import { expect, test, type Page } from "@playwright/test";
import { appPath, invocations, mockUrl, resetMock } from "./fixtures";

/**
 * Snoozed and Archived rows drag into the pane grid (docs/notes/preview-tabs-2-row-drag.md), what
 * only a browser shows: a pointer drag of an archived row into a pane while the window is in a
 * space other than the default one (where an archived thread falls back), and of a snoozed row
 * onto a pane's edge; each lands, and the thread stays archived or snoozed. Which rows drag and
 * which command each drop runs are vitest's (shell/drag/threadSource.test.ts,
 * sidebar/shell/ShellSidebarList.test.tsx). SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const pane = (id: string, tabs: Tab[]): Node => ({ t: "pane", id, tabs, active: tabs[0]?.id ?? "" });

// The mock's world: s-7 "Spike a canvas sidebar" is archived, s-8 "Refactor the gh poller" snoozed.
const ARCHIVED = { id: "s-7", name: "Spike a canvas sidebar" };
const SNOOZED = { id: "s-8", name: "Refactor the gh poller" };

/** Main (the default space) holds `main`; with `review`, the window is in a second space, Review, holding it. */
async function seed(main: Node, review: Node | null = null): Promise<void> {
  const spaces = [{ id: "sp-main", name: "Main", root: main, focus: "p-1", mru: [], drafts: [] }, ...(review ? [{ id: "sp-review", name: "Review", root: review, focus: "p-r", mru: [], drafts: [] }] : [])];
  const state = { v: 1, spaces, current_space: review ? "sp-review" : "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

/** A space's stored tree by the threads its tabs show: `row([s-1] [s-8])`. */
async function outline(space: string): Promise<string> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  const spaces = ((await res.json()) as { state: { spaces: { id: string; root: Node | null }[] } }).state.spaces;
  const draw = (n: Node | null): string => (!n ? "" : n.t === "pane" ? `[${n.tabs.map((t) => String(t.thread ?? t.kind)).join(",")}]` : `${n.dir}(${n.kids.map(draw).join(" ")})`);
  return draw(spaces.find((s) => s.id === space)?.root ?? null);
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await expect(page.locator("[data-shell-list]")).toBeVisible();
}

/** Opens a collapsed footer (Snoozed, Archived) so its rows are drawn. */
async function expand(page: Page, section: "snoozed" | "archived"): Promise<void> {
  const header = page.getByTestId(`${section}-header`);
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

type Box = { x: number; y: number; width: number; height: number };
async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

const row = (page: Page, id: string) => page.locator(`[data-row-key="s:${id}"]`);

/** Presses on a sidebar row and moves to `to`, holding the button; the ghost names the thread. */
async function liftRow(page: Page, id: string, name: string, to: { x: number; y: number }): Promise<void> {
  await row(page, id).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
  const from = await box(page, `[data-row-key="s:${id}"]`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
  await expect(page.getByTestId("shell-drag-ghost")).toContainText(name);
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

test.beforeEach(async () => {
  await resetMock();
});

test("an archived row dragged into a pane of a space that is not the default one opens there and stays archived", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]), pane("p-r", [thread("s-2")]));
  await openShell(page);
  await expand(page, "archived");
  const p = await box(page, '[data-testid="shell-pane"][data-pane-id="p-r"]');
  await liftRow(page, ARCHIVED.id, ARCHIVED.name, { x: p.x + p.width / 2, y: p.y + p.height / 2 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "pane");
  await page.mouse.up();
  await expect.poll(() => outline("sp-review")).toBe(`[s-2,${ARCHIVED.id}]`);
  await expect(page.locator('[data-testid="shell-pane"][data-pane-id="p-r"] [data-testid="shell-tab"]')).toHaveCount(2);
  await expect(row(page, ARCHIVED.id)).toHaveAttribute("data-section", "archived");
  await expect(page.getByTestId("shell-drag-shield")).toHaveCount(0);
});

test("a snoozed row dragged onto a pane's edge opens its thread in a new pane there and stays snoozed", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  await expand(page, "snoozed");
  const p = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
  await liftRow(page, SNOOZED.id, SNOOZED.name, { x: p.x + p.width - 30, y: p.y + p.height / 2 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "edge");
  await page.mouse.up();
  await expect.poll(() => outline("sp-main")).toBe(`row([s-1] [${SNOOZED.id}])`);
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  await expect(row(page, SNOOZED.id)).toHaveAttribute("data-section", "snoozed");
  expect((await invocations()).filter((i) => i.name === "thread.open").map((i) => i.args)).toEqual([expect.objectContaining({ id: SNOOZED.id, split: "p-1", edge: "right" })]);
});

/** SHOTS=<dir>: an archived row mid-drag over a pane with the drop highlight, and the window after the drop; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`archived row drag screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await seed(pane("p-1", [thread("s-1")]));
    await openShell(page);
    await expand(page, "archived");
    const p = await box(page, '[data-testid="shell-pane"][data-pane-id="p-1"]');
    // The pane's left edge, so the ghost beside the pointer stays in the window.
    await liftRow(page, ARCHIVED.id, ARCHIVED.name, { x: p.x + 80, y: p.y + p.height / 2 });
    await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "edge");
    // The preview glides between targets: let it settle.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
    await page.screenshot({ path: at("archived-row-drag") });
    await page.mouse.up();
    await expect.poll(() => outline("sp-main")).toBe(`row([${ARCHIVED.id}] [s-1])`);
    await page.mouse.move(700, 20);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));
    await page.screenshot({ path: at("archived-row-dropped") });
  });
}
