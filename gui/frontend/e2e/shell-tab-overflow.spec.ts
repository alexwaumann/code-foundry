import { expect, test, type Locator } from "@playwright/test";
import { CF, resetMock } from "./fixtures";
import { openShellApp, paneNode, paneOf, rowNode, seedLayout, threadTab } from "./shell";

/**
 * A pane with more tabs than its strip holds, even as icons (docs/notes/fuzz-2026-11-15-grid.md):
 * the tabs scroll inside their own area, the "+", Collapse and Full screen controls stay in the
 * pane, and the active tab is scrolled into view when it changes. Geometry, so a real browser's;
 * how tabs shorten to fit is vitest's (shell/geometry/tabFit.test.ts, PaneTabStrip.test.tsx).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

const files = Array.from({ length: 18 }, (_, i) => {
  const path = `src/module-${String(i + 1).padStart(2, "0")}.ts`;
  return { id: `t-file-${String(i + 1)}`, kind: "file", thread: "s-1", params: { project: "repo-cf", base: CF, path }, title: path.split("/").pop() };
});
const last = files.at(-1)?.id ?? "";

test.beforeEach(async () => {
  await resetMock();
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", files, last)]), "p-2");
});

async function boxOf(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return b;
}

/** Whether `inner` lies within `outer` horizontally (a pixel of rounding allowed). */
async function within(inner: Locator, outer: Locator): Promise<boolean> {
  const [i, o] = [await boxOf(inner), await boxOf(outer)];
  return i.x >= o.x - 1 && i.x + i.width <= o.x + o.width + 1;
}

test("many tabs: the controls stay in the pane and the active tab stays in view", async ({ page }) => {
  await openShellApp(page);
  const pane = paneOf(page, "p-2");
  const scroller = pane.getByTestId("shell-tab-scroller");
  const active = () => pane.locator('[data-testid="shell-tab"][data-active]');
  await expect(active()).toHaveAttribute("data-tab-id", last);
  // More tabs than room: the tabs scroll, the strip does not.
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  for (const control of [pane.getByRole("button", { name: "Open tab" }), pane.getByTestId("shell-collapse"), pane.getByTestId("shell-fullscreen")]) {
    await expect.poll(() => within(control, pane)).toBe(true);
  }
  await expect.poll(() => within(active(), scroller)).toBe(true);

  // The next tab goes round to the first: it scrolls into view.
  await pane.getByTestId("shell-pane-body").click();
  await page.keyboard.press("Meta+Shift+BracketRight");
  await expect(active()).toHaveAttribute("data-tab-id", files[0]?.id ?? "");
  await expect.poll(() => within(active(), scroller)).toBe(true);
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(0);
});

/** SHOTS=<dir>: the pane with many tabs, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`tab overflow screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await openShellApp(page);
    const pane = paneOf(page, "p-2");
    await expect(pane.locator('[data-testid="shell-tab"][data-active]')).toBeVisible();
    await page.mouse.move(10, 790);
    const b = await boxOf(pane);
    await page.screenshot({ path: `${shots ?? ""}/tab-overflow${scheme === "light" ? "-light" : ""}.png`, clip: { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: 120 } });
  });
}
