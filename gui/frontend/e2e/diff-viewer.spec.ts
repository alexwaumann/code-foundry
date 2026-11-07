import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * The Diff tab where only a real browser can tell (docs/notes/diff-viewer-2.md): the file list
 * moving between rail and top with the panel's real width, and the list scrolling inside
 * itself. Everything else is src/components/diff/DiffView.test.tsx. Set SHOTS=<dir> to save the
 * pull request's screenshots (WebKit, dark and light, wide and narrow).
 */

const list = (page: Page) => page.getByTestId("diff-file-list");
const file = (page: Page) => page.getByTestId("diff-file");

async function panelWidth(page: Page, w: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(w)}))`);
}

async function openDiff(page: Page, width: number): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await openThreadChanges(page);
  await panelWidth(page, width);
  await expect(list(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the list follows the panel's own width, not the window's, and keeps the file on screen", async ({ page }) => {
  await openDiff(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
  await page.locator('[data-nav-key="f:README.md"]').click();
  await expect(file(page)).toHaveAttribute("data-path", "README.md");

  const rail = await list(page).boundingBox();
  const diff = await file(page).boundingBox();
  if (!rail || !diff) throw new Error("no boxes");
  expect(Math.abs(rail.x + rail.width - diff.x)).toBeLessThanOrEqual(1);
  expect(rail.height).toBeGreaterThan(400);

  // The window stays as wide as it was: only the panel narrows.
  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(file(page)).toHaveAttribute("data-path", "README.md");
  const top = await list(page).boundingBox();
  const under = await file(page).boundingBox();
  if (!top || !under) throw new Error("no boxes");
  expect(Math.abs(top.y + top.height - under.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(top.width - under.width)).toBeLessThanOrEqual(1);

  await panelWidth(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
});

test("a long list is virtualized and scrolls inside itself, in both layouts", async ({ page }) => {
  await mockPost("compare/files?count=800");
  await openDiff(page, 760);
  const rows = page.getByTestId("diff-file-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  expect(await rows.locator("[data-nav-key]").count()).toBeLessThan(120);

  const height = await rows.evaluate((e) => e.clientHeight);
  const content = await rows.evaluate((e) => e.scrollHeight);
  expect(content).toBeGreaterThan(height * 4);
  await rows.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(page.locator('[data-nav-key="f:generated/file-0799.ts"]')).toBeVisible();
  const box = await rows.boundingBox();
  const diffBox = await file(page).boundingBox();
  if (!box || !diffBox) throw new Error("no boxes");
  expect(box.y + box.height).toBeLessThanOrEqual(diffBox.y + diffBox.height + 1);

  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  expect(await rows.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(150);
  expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThan(300);
});

test("a live update keeps the rail on the same file, and the cursor's row never pulls it back", async ({ page }) => {
  await mockPost("compare/files?count=120");
  await openDiff(page, 760);
  const rows = page.getByTestId("diff-file-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  await expect.poll(() => rows.evaluate((e) => e.scrollTop)).toBe(0);
  const topRow = () =>
    rows.evaluate((e) => {
      const box = e.getBoundingClientRect();
      return [...e.querySelectorAll("[data-nav-key]")].find((r) => r.getBoundingClientRect().top >= box.top - 1)?.getAttribute("data-nav-key");
    });
  const scrollTo = (y: number) =>
    rows.evaluate((e, to) => {
      e.scrollTop = to;
    }, y);

  // Past the overscan and back to where the cursor's row mounts again, off screen: it stays.
  await scrollTo(1800);
  await expect.poll(() => rows.evaluate((e) => e.scrollTop)).toBe(1800);
  await scrollTo(120);
  await page.waitForTimeout(200);
  expect(await rows.evaluate((e) => e.scrollTop)).toBe(120);

  await scrollTo(1800);
  await expect.poll(topRow).toContain("generated/");
  const before = await topRow();

  // Ten files sort in above: the same file stays at the top, 300px further down the list.
  const path = await page.getByTestId("diff-surface").getAttribute("data-path");
  await mockPost("compare/files?count=120&first=10");
  await mockPost(`worktree/dirty?path=${encodeURIComponent(path ?? "")}&modified=7`);
  await expect(page.locator('[data-nav-key="f:.first/file-0000.ts"]')).toHaveCount(0);
  await expect(page.getByTestId("diff-totals")).toContainText(/1[3-9]\d files/);
  expect(await topRow()).toBe(before);
  expect(await rows.evaluate((e) => e.scrollTop)).toBe(2100);
});

/** The cursor's row is inside every box that scrolls around it, and the window. */
const cursorInView = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector('[aria-selected="true"][data-nav-key]');
    if (!row) return false;
    const r = row.getBoundingClientRect();
    for (let p = row.parentElement; p; p = p.parentElement) {
      if (!/auto|scroll/.test(getComputedStyle(p).overflowY)) continue;
      const box = p.getBoundingClientRect();
      if (r.top < box.top - 1 || r.bottom > box.bottom + 1) return false;
    }
    return r.top >= 0 && r.bottom <= innerHeight;
  });

test("the keyboard brings its row into view in a virtualized list, past what is mounted", async ({ page }) => {
  await mockPost("compare/files?count=120");
  await openDiff(page, 760);
  const rows = page.getByTestId("diff-file-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  await list(page).focus();
  await page.keyboard.press("End");
  await expect(page.locator('[aria-selected="true"][data-nav-key]')).toHaveAttribute("data-nav-key", /file-0119/);
  await expect.poll(() => cursorInView(page)).toBe(true);
  await page.keyboard.press("Home");
  await expect.poll(() => rows.evaluate((e) => e.scrollTop)).toBe(0);
  await expect.poll(() => cursorInView(page)).toBe(true);
});

test("the list on top comes back on the current row, not at the top", async ({ page }) => {
  await mockPost("compare/files?count=30");
  await openDiff(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  const rows = page.getByTestId("diff-file-rows");
  await page.locator('[data-nav-key="f:generated/file-0024.ts"]').scrollIntoViewIfNeeded();
  await page.locator('[data-nav-key="f:generated/file-0024.ts"]').click();
  await expect(file(page)).toHaveAttribute("data-path", "generated/file-0024.ts");
  await page.getByTestId("diff-fold").click();
  await expect(rows).toHaveCount(0);
  await page.getByTestId("diff-fold").click();
  await expect(rows).toBeVisible();
  await expect.poll(() => rows.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => cursorInView(page)).toBe(true);

  // The width takes the list away and brings it back too.
  await panelWidth(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
  await expect.poll(() => cursorInView(page)).toBe(true);
  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect.poll(() => cursorInView(page)).toBe(true);
});

// The list on top, in the sizes it meets: alone in the panel, and a stacked split, where the
// panel gives it half the height. At 1280x800 a split's tab is 342px, and the list used to leave
// the code 33 of them. Too short for both, the list folds and the code has the whole tab.
for (const [name, w, h, stacked, listed, code] of [
  ["1280x800, alone", 1280, 800, false, true, 400],
  ["1280x800, a stacked split", 1280, 800, true, false, 200],
  ["1024x640, a stacked split", 1024, 640, true, false, 130],
  ["1920x1080, a stacked split", 1920, 1080, true, true, 180],
] as const) {
  test(`the list on top leaves the code readable: ${name}`, async ({ page }) => {
    await mockPost("compare/files?count=40");
    await page.setViewportSize({ width: w, height: h });
    await openDiff(page, 480);
    await expect(list(page)).toHaveAttribute("data-layout", "top");
    if (stacked) {
      await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.splitPanel("current"))`);
      await expect(page.locator('[data-split="true"]').first()).toBeVisible();
    }
    await expect(file(page)).toBeVisible();
    await expect(page.getByTestId("diff-file-rows")).toHaveCount(listed ? 1 : 0);
    const whole = await file(page).boundingBox();
    const header = await file(page).getByTestId("file-header").boundingBox();
    if (!whole || !header) throw new Error("no boxes");
    expect(whole.y + whole.height - (header.y + header.height)).toBeGreaterThanOrEqual(code);
  });
}

for (const scheme of ["dark", "light"] as const) {
  for (const [layout, width] of [["wide", 800], ["narrow", 420]] as const) {
    test(`diff viewer screenshots (${scheme}, ${layout})`, async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await page.emulateMedia({ colorScheme: scheme });
      await openDiff(page, width);
      await page.locator('[data-nav-key="f:README.md"]').click();
      await expect(file(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
      await page.mouse.move(5, 5);
      await page.screenshot({ path: `${shots ?? ""}/diff-${layout}-${scheme}.png` });
    });
  }
}

for (const scheme of ["dark", "light"] as const) {
  for (const [name, hide, width] of [["framed", [], 700], ["focused", ["compare", "files"], 700], ["framed-narrow", [], 420]] as const) {
    test(`a thread's framing screenshots (${scheme}, ${name})`, async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await page.emulateMedia({ colorScheme: scheme });
      await openDiff(page, width);
      const target = { project: "repo-cf", worktree: CF, base: { kind: "merge-base" }, head: { kind: "working" }, file: "README.md", oldPath: "", own: true, thread: "t1", paths: ["README.md", "notes/plan.md"], heading: "The two files behind the flake", note: "Row height now comes from one place.", hide };
      await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openDiffInPanel("current", ${JSON.stringify(target)}))`);
      await expect(page.getByTestId("diff-model-title")).toBeVisible();
      await expect(file(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
      await page.mouse.move(5, 5);
      await page.screenshot({ path: `${shots ?? ""}/diff-${name}-${scheme}.png` });
    });
  }
}
