import { expect, test, type Locator, type Page } from "@playwright/test";
import { invocations, resetMock, threadsOpenAsTabs } from "./fixtures";
import { focusedPane, layoutState, openShellApp, paneNode, paneOf, rowNode, seedLayout, tabOfKind, threadTab } from "./shell";

/**
 * The Undo toast after a put-away, and the pane a put-away keeps (docs/notes/put-away-undo.md).
 * What the toast says, which commands Undo runs, the fixed id, the keys' precedence and the hover
 * pause are unit-tested (src/stores/putAwayUndo.test.ts, src/components/ui/undoToast.test.tsx); the
 * pane rule in Go (internal/layout keep_pane cases, internal/daemon TestLayoutGlue*) and the mock's
 * copy in mock/layout.test.ts. This keeps what only the browser shows: the toast's corner and
 * margins with the sidebar open and as a rail, cmd+z from a focused composer reaching the toast
 * through the keymap, and a pane whose only tab was put away showing New thread. SHOTS=<dir> makes
 * the PR's screenshots.
 */

const shots = process.env.SHOTS;
const MARGIN = 20;

// s-3 "Fix resize race" and s-4: idle, nothing running, so neither asks first.
test.beforeEach(async () => {
  await resetMock();
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
});

const undoToast = (page: Page): Locator => page.locator("[data-sonner-toast]").filter({ hasText: "Undo" });

/** The toast's distance from the window's left and bottom edges. */
async function margins(page: Page, toast: Locator): Promise<{ left: number; bottom: number }> {
  const box = await toast.boundingBox();
  const vp = page.viewportSize();
  if (!box || !vp) throw new Error("no toast box");
  return { left: Math.round(box.x), bottom: Math.round(vp.height - (box.y + box.height)) };
}

/** s-3 alone in the left pane (focused), s-4 and the pull requests in the right one. */
async function twoPanes(): Promise<void> {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-3")]), paneNode("p-2", [threadTab("s-4"), { id: "t-prs", kind: "prs" }])]), "p-1");
}

test("the toast sits in the window's bottom-left corner, 20px in, with the sidebar open and as a rail", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await twoPanes();
  await openShellApp(page);
  await page.keyboard.press("Meta+Shift+S");
  const toast = undoToast(page);
  await expect(toast).toContainText("Snoozed until tomorrow, 9:00 AM");
  await expect(toast).toContainText("Fix resize race");
  await expect(toast.getByRole("button", { name: /^Undo/ })).toContainText("⌘Z");
  await expect(toast.locator("[data-close-button]")).toBeVisible();
  await expect.poll(() => margins(page, toast)).toEqual({ left: MARGIN, bottom: MARGIN }); // once it has slid in
  await page.keyboard.press("Escape");
  await expect(toast).toHaveCount(0);

  await page.keyboard.press("Meta+b");
  await expect(page.getByTestId("sidebar-rail")).toBeVisible();
  await paneOf(page, "p-2").getByTestId("thread-pane").click();
  await page.keyboard.press("Meta+Shift+A");
  await expect(toast).toContainText("Archived");
  await expect.poll(() => margins(page, toast)).toEqual({ left: MARGIN, bottom: MARGIN }); // once it has slid in
});

test("a pane whose only tab is put away shows New thread; cmd+z from that focused composer undoes it into the pane", async ({ page }) => {
  await twoPanes();
  await openShellApp(page);
  await page.keyboard.press("Meta+Shift+S");
  await expect(undoToast(page)).toBeVisible();
  // The pane stays, New thread in the thread's place; the other pane is as it was.
  await expect(paneOf(page, "p-1").locator('[data-testid="shell-tab"]')).toHaveCount(1);
  await expect(paneOf(page, "p-1").locator('[data-testid="shell-tab"][data-kind="compose"]')).toBeVisible();
  await expect(paneOf(page, "p-2").locator('[data-testid="shell-tab"]')).toHaveCount(2);
  const prompt = paneOf(page, "p-1").getByTestId("composer-input");
  await prompt.click();
  await expect(prompt).toBeFocused();
  await page.keyboard.press("Meta+z");
  await expect(undoToast(page)).toHaveCount(0);
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.snooze" && i.args.clear === "true").map((i) => i.args.id)).toEqual(["s-3"]);
  // Back in place of the untouched composer, and focused again.
  await expect(paneOf(page, "p-1").locator('[data-testid="shell-tab"]')).toHaveCount(1);
  await expect(focusedPane(page).locator('[data-testid="thread-pane"][data-thread-id="s-3"]')).toBeVisible();
  await expect(tabOfKind(page, "compose")).toHaveCount(0);
});

test("an archive keeps the pane too; with no undo toast cmd+z is the composer's again", async ({ page }) => {
  await twoPanes();
  await openShellApp(page);
  await page.keyboard.press("Meta+Shift+A");
  await expect(undoToast(page)).toContainText("Archived");
  await expect(paneOf(page, "p-1").locator('[data-testid="shell-tab"][data-kind="compose"]')).toBeVisible();
  const st = await layoutState();
  expect(st.spaces[0]?.root).toMatchObject({ t: "split", kids: [{ id: "p-1", tabs: [{ kind: "compose" }] }, { id: "p-2" }] });
  await page.keyboard.press("Escape");
  await expect(undoToast(page)).toHaveCount(0);
  const prompt = paneOf(page, "p-1").getByTestId("composer-input");
  await prompt.click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Meta+z");
  await expect(prompt).not.toContainText("hello");
  expect((await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.args.archived ?? "")).not.toContain("false");
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
  await page.screenshot({ path: `${shots ?? ""}/${name}.png` });
}

for (const scheme of ["dark", "light"] as const) {
  test(`the undo toast and the kept pane, ${scheme} (screenshots)`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1200, height: 760 });
    await twoPanes();
    await openShellApp(page);
    await shot(page, `only-tab-before-${scheme}`);
    await page.keyboard.press("Meta+Shift+S");
    const toast = undoToast(page);
    await expect(toast).toBeVisible();
    // Held open: the pointer over it pauses its timer.
    await toast.hover();
    await shot(page, `undo-toast-sidebar-${scheme}`);
    await page.keyboard.press("Escape");
    await expect(toast).toHaveCount(0);
    await page.mouse.move(600, 300);
    await shot(page, `only-tab-after-${scheme}`);
    await page.keyboard.press("Meta+b");
    await expect(page.getByTestId("sidebar-rail")).toBeVisible();
    await paneOf(page, "p-2").getByTestId("thread-pane").click();
    await page.keyboard.press("Meta+Shift+A");
    await expect(toast).toContainText("Archived");
    await toast.hover();
    await shot(page, `undo-toast-rail-${scheme}`);
  });
}
