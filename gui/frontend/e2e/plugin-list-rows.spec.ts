import { expect, test, type Page } from "@playwright/test";
import { mockPost, openHelloDemo, pluginActs, resetMock } from "./fixtures";

/**
 * A list's interactive rows in a real browser (docs/notes/plugin-list-rows.md): only what
 * jsdom cannot show, the pointer drag (lift, drop line, release) with real geometry, and
 * the drag's edge scroll over a long, virtualized list in a sized pane. Payloads, the
 * optimistic state, the keyboard move, the editor and the add input are vitest
 * (components/plugin/listrows.test.tsx, rows.test.ts).
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const rowEl = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-row"][data-key="${key}"]`);

async function openTodo(page: Page): Promise<void> {
  await openHelloDemo(page);
  await surface(page).locator('[data-testid="plugin-tab"][data-key="todo"]').click();
  await expect(rowEl(page, "todo-1")).toBeVisible();
}

async function order(page: Page, list: string): Promise<string[]> {
  return surface(page)
    .locator(`[data-testid="plugin-list-rows"][data-key="${list}"] [data-testid="plugin-row"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-key") ?? ""));
}

/** Presses `key`'s grip (hovering its row shows it) and moves the pointer to y in steps. */
async function grab(page: Page, key: string): Promise<{ x: number; y: number }> {
  await rowEl(page, key).hover();
  const g = await rowEl(page, key).getByTestId("plugin-row-grip").boundingBox();
  if (!g) throw new Error(`no grip on ${key}`);
  const at = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  return at;
}

test.beforeEach(async () => {
  await resetMock();
});

test("a pointer drag lifts the row, draws the drop line and moves it on release", async ({ page }) => {
  await openTodo(page);
  expect(await order(page, "todo-open")).toEqual(["todo-1", "todo-2", "todo-3", "todo-4", "todo-5"]);
  const from = await grab(page, "todo-5");
  const first = await rowEl(page, "todo-1").boundingBox();
  if (!first) throw new Error("no first row");
  await page.mouse.move(from.x, first.y + 4, { steps: 8 });
  await expect(page.getByTestId("plugin-row-lifted")).toBeVisible();
  const line = await page.getByTestId("plugin-row-drop").boundingBox();
  expect(Math.abs((line?.y ?? 0) + 1 - first.y)).toBeLessThanOrEqual(2);
  await expect(rowEl(page, "todo-5")).toHaveClass(/opacity-35/);
  await page.mouse.up();
  await expect(page.getByTestId("plugin-row-lifted")).toHaveCount(0);
  await expect.poll(() => order(page, "todo-open")).toEqual(["todo-5", "todo-1", "todo-2", "todo-3", "todo-4"]);
  expect((await pluginActs()).filter((a) => a.includes("action=move"))).toEqual([expect.stringMatching(/ todo-5 .* value= action=move$/)]);
  // The release clicked nothing: the row's place is all that changed.
  await expect(rowEl(page, "todo-5").getByTestId("plugin-row-edit")).toHaveCount(0);
});

test("dragging to a scrolled pane's edge scrolls it, and a virtualized list takes the drop", async ({ page }) => {
  await openTodo(page);
  const rows = Array.from({ length: 80 }, (_, i) => ({ key: `r${String(i)}`, title: `Row ${String(i)}` }));
  const before = Number((await surface(page).getAttribute("data-version")) ?? "0");
  await mockPost(`plugin/demotab?tab=${encodeURIComponent(`view:${JSON.stringify({ view: { nodes: [{ key: "box", pane: { height: 300, children: [{ key: "lst", list: { rows, reorderable: true } }] } }] } })}`)}`);
  await expect.poll(async () => Number((await surface(page).getAttribute("data-version")) ?? "0")).toBeGreaterThan(before);
  const pane = surface(page).locator('[data-testid="plugin-pane"][data-key="box"]');
  await expect(pane.locator('[data-testid="plugin-list"]')).toHaveAttribute("data-virtual", "true");
  const box = await pane.boundingBox();
  if (!box) throw new Error("no pane");
  const from = await grab(page, "r1");
  // Into the bottom edge zone and held: the pane scrolls under the lifted row.
  await page.mouse.move(from.x, box.y + box.height - 6, { steps: 10 });
  await expect.poll(() => pane.evaluate((el) => el.scrollTop), { timeout: 5000 }).toBeGreaterThan(600);
  // Back to the middle (the scroll stops) and dropped between two drawn rows.
  await page.mouse.move(from.x, box.y + box.height / 2, { steps: 4 });
  const line = page.getByTestId("plugin-row-drop");
  await expect(line).toBeVisible();
  await page.mouse.up();
  const moved = (await pluginActs()).filter((a) => a.includes(" r1 ") && a.includes("action=move"));
  expect(moved).toHaveLength(1);
  const after = /value=(r\d+) action=move$/.exec(moved[0] ?? "")?.[1] ?? "";
  expect(Number(after.slice(1))).toBeGreaterThan(20);
  // The mock moved it in its view: r1 sits right under its new upper neighbour.
  await expect
    .poll(() => pane.locator('[data-testid="plugin-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-key"))))
    .toEqual(expect.arrayContaining([after, "r1"]));
  const keys = await pane.locator('[data-testid="plugin-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
  expect(keys.indexOf("r1")).toBe(keys.indexOf(after) + 1);
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1280x800, dark and light: the Todo tab, a drag, a rename with text in the add input. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("todo, drag, edit and add", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await openTodo(page);
      const shot = (name: string) => page.screenshot({ path: `${shots ?? ""}/list-rows-${name}-${scheme}.png` });
      await rowEl(page, "todo-2").hover();
      await page.waitForTimeout(200);
      await shot("todo");
      const from = await grab(page, "todo-3");
      const first = await rowEl(page, "todo-2").boundingBox();
      await page.mouse.move(from.x + 6, (first?.y ?? 0) + 6, { steps: 8 });
      await page.waitForTimeout(150);
      await shot("drag");
      await page.mouse.up();
      await expect.poll(() => order(page, "todo-open")).toEqual(["todo-1", "todo-3", "todo-2", "todo-4", "todo-5"]);
      await surface(page).getByRole("textbox", { name: "Add a task" }).fill("Check the zoom fix on a 4K display");
      await rowEl(page, "todo-4").getByTestId("plugin-row-title").locator("span").first().dblclick();
      await page.keyboard.press("Meta+ArrowRight");
      await page.keyboard.type(" for v0.22");
      await page.waitForTimeout(150);
      await shot("edit");
    });
  });
}
