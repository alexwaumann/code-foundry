import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, mockPost, resetMock } from "./fixtures";
import { openShellApp, paneNode, rowNode, seedLayout, threadTab } from "./shell";
import { diffTab, seedBeside, setPaneSize } from "./shell-surfaces";

/**
 * The Diff tab where only a real browser can tell (docs/notes/diff-viewer-2.md): the file list
 * moving between rail and top with its pane's real width, and the list scrolling inside
 * itself. Everything else is src/components/diff/DiffView.test.tsx. Set SHOTS=<dir> to save the
 * pull request's screenshots (WebKit, dark and light, wide and narrow).
 */

const list = (page: Page) => page.getByTestId("diff-file-list");
const column = (page: Page) => page.getByTestId("diff-list-column");
const file = (page: Page) => page.getByTestId("diff-file");

/** s-1's Diff tab in a pane right of the thread's, `width` px wide. */
async function openDiff(page: Page, width: number): Promise<void> {
  await seedBeside("s-1", [diffTab("s-1")]);
  await openShellApp(page);
  await setPanelWidth(page, width);
  await expect(list(page)).toBeVisible();
}

/** The Diff tab's pane to `width` px, the window as it is. */
const setPanelWidth = (page: Page, width: number) => setPaneSize(page, "p-2", width);

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the list follows its pane's own width, not the window's, and keeps the file on screen", async ({ page }) => {
  await openDiff(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
  await page.locator('[data-nav-key="f:README.md"]').click();
  await expect(file(page)).toHaveAttribute("data-path", "README.md");

  const rail = await column(page).boundingBox();
  const diff = await file(page).boundingBox();
  if (!rail || !diff) throw new Error("no boxes");
  expect(Math.abs(rail.x + rail.width - diff.x)).toBeLessThanOrEqual(1);
  expect(rail.height).toBeGreaterThan(400);

  // The window stays as wide as it was: only the pane narrows.
  await setPanelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(file(page)).toHaveAttribute("data-path", "README.md");
  const top = await column(page).boundingBox();
  const under = await file(page).boundingBox();
  if (!top || !under) throw new Error("no boxes");
  expect(Math.abs(top.y + top.height - under.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(top.width - under.width)).toBeLessThanOrEqual(1);

  await setPanelWidth(page, 760);
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

  await setPanelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  expect(await rows.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(150);
  expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThan(300);
});

test("Commits sit at the foot of the list, and a long list scrolls inside itself in both layouts", async ({ page }) => {
  await mockPost("compare/commits?count=800");
  await openDiff(page, 760);
  const section = page.getByTestId("diff-commits");
  const toggle = page.getByTestId("diff-commits-toggle");
  await expect(section).toHaveAttribute("data-open", "false");
  const atFoot = async () => {
    const foot = await section.boundingBox();
    const all = await column(page).boundingBox();
    if (!foot || !all) throw new Error("no boxes");
    expect(Math.abs(foot.y + foot.height - (all.y + all.height))).toBeLessThanOrEqual(1);
  };
  await atFoot();

  await toggle.click();
  const rows = page.getByTestId("diff-commit-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  expect(await rows.locator("[data-nav-key]").count()).toBeLessThan(120);
  await atFoot();
  expect((await page.getByTestId("diff-file-rows").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(90);
  await rows.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(rows.getByText("Older commit 0799")).toBeVisible();

  // On top the code keeps its share with the list open.
  await setPanelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(section).toHaveAttribute("data-open", "true");
  expect(await rows.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(90);
  expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThan(180);
});

/** Sizes the window so the Diff tab is `h` tall: what is around it does not change. */
async function surfaceHeight(page: Page, h: number): Promise<void> {
  const surface = page.getByTestId("diff-surface");
  const now = (await surface.boundingBox())?.height ?? 0;
  const window = page.viewportSize();
  await page.setViewportSize({ width: window?.width ?? 1440, height: (window?.height ?? 900) + Math.round(h - now) });
  await expect.poll(async () => Math.round((await surface.boundingBox())?.height ?? 0)).toBe(h);
}

/** `inner` lies wholly inside `outer`, so it can be seen and pressed. */
async function within(inner: Locator, outer: Locator): Promise<void> {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) throw new Error("no boxes");
  expect(a.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1);
}

for (const [layout, width] of [["top", 480], ["rail", 760]] as const) {
  test(`the Commits toggle stays in reach at every height, ${layout}`, async ({ page }) => {
    await mockPost("compare/commits?count=20");
    await openDiff(page, width);
    await expect(list(page)).toHaveAttribute("data-layout", layout);
    const surface = page.getByTestId("diff-surface");
    const toggle = page.getByTestId("diff-commits-toggle");
    const rows = page.getByTestId("diff-commit-rows");
    for (const h of [600, 500, 432, 400, 350, 300, 250]) {
      await surfaceHeight(page, h);
      await within(toggle, surface);
      await toggle.click();
      await expect(rows).toBeVisible();
      await within(toggle, surface);
      await within(rows, surface);
      await toggle.click();
      await expect(rows).toHaveCount(0);
      await within(toggle, surface);
    }
    // Left open as the pane shrinks, which is what `commits=1` keeps: it can still be folded.
    await surfaceHeight(page, 600);
    await toggle.click();
    for (const h of [500, 400, 300, 250]) {
      await surfaceHeight(page, h);
      await within(toggle, surface);
      await within(rows, surface);
      await within(file(page), surface);
      // The file's header and some of its code, and in the rail some of the list.
      expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(70);
      if (layout === "rail") expect((await page.getByTestId("diff-file-rows").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(60);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/commits-open-${layout}-${String(h)}.png` });
    }
    await toggle.click();
    await expect(rows).toHaveCount(0);
  });
}

test("a long subject leaves the diff in reach, and the band keeps its share of a short tab", async ({ page }) => {
  await mockPost("compare/commits?count=3&subject=8000");
  await openDiff(page, 480);
  await page.getByTestId("diff-commits-toggle").click();
  await page.getByTestId("commit-subject").first().click();
  const band = page.getByTestId("diff-commit");
  await expect(page.getByTestId("diff-commit-body")).toBeVisible();
  for (const [layout, width] of [["top", 480], ["rail", 760]] as const) {
    await setPanelWidth(page, width);
    await expect(list(page)).toHaveAttribute("data-layout", layout);
    for (const h of [800, 400, 250]) {
      await surfaceHeight(page, h);
      const box = await band.boundingBox();
      const subject = await page.getByTestId("diff-commit-subject").boundingBox();
      expect(subject?.height ?? 999).toBeLessThanOrEqual(44);
      expect(box?.height ?? 999).toBeLessThanOrEqual(h * 0.4 + 1);
      await within(file(page), page.getByTestId("diff-surface"));
      if (h > 250) expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThan(40);
    }
  }
});

test("a click on a commit keeps the rail and the place in the list, and All changes comes back", async ({ page }) => {
  await mockPost("compare/commits?count=80");
  await openDiff(page, 760);
  await page.getByTestId("diff-commits-toggle").click();
  const rows = page.getByTestId("diff-commit-rows");
  await expect(rows).toHaveAttribute("data-virtual", "true");
  await rows.evaluate((e) => {
    e.scrollTop = 600;
  });
  await rows.getByText("Older commit 0020").click();
  await expect(page.getByTestId("diff-commit")).toBeVisible();
  await expect(page.getByTestId("diff-head")).toHaveText(/^e\d{6}$/);
  expect(await rows.evaluate((e) => e.scrollTop)).toBe(600);
  // The message sits over the diff, not over the list.
  const band = await page.getByTestId("diff-commit").boundingBox();
  const diff = await file(page).boundingBox();
  if (!band || !diff) throw new Error("no boxes");
  expect(Math.abs(band.y + band.height - diff.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(band.x - diff.x)).toBeLessThanOrEqual(1);

  await page.getByTestId("diff-all-changes").click();
  await expect(page.getByTestId("diff-commit")).toHaveCount(0);
  await expect(page.getByTestId("diff-head")).toHaveText("Working tree");
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
  await setPanelWidth(page, 760);
  await expect(list(page)).toHaveAttribute("data-layout", "rail");
  await expect.poll(() => cursorInView(page)).toBe(true);
  await setPanelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect.poll(() => cursorInView(page)).toBe(true);
});

// The list on top, in the sizes it meets: alone in a pane, and in a pane over another, half the
// height. The side panel's split tab was 342px at 1280x800 and the list used to leave the code 33
// of them; a pane's Diff tab there is 282px (the top bar and the strip take more than the panel's
// header did), 654px alone, and 202px at 1024x640. Too short for both, the list folds and the code has the whole tab.
// Since every pane keeps 480 x 400 (docs/notes/shell-25f-sizes.md) a pane of a stacked split is
// 400px tall at the least: the shortest met is 410 at 1280x900; at 1280x800 and 1024x640 the
// column does not fit and folds beside the focused thread, so those sizes are gone.
for (const [name, w, h, stacked, listed, code] of [
  ["1280x800, alone", 1280, 800, false, true, 320],
  ["1280x900, a stacked split", 1280, 900, true, false, 140],
  ["1920x1080, a stacked split", 1920, 1080, true, true, 180],
] as const) {
  test(`the list on top leaves the code readable: ${name}`, async ({ page }) => {
    await mockPost("compare/files?count=40");
    await page.setViewportSize({ width: w, height: h });
    if (stacked) {
      // The diff over the Pull Requests page, in a column right of the thread.
      const right: Parameters<typeof seedLayout>[0] = { t: "split", id: "s-c", dir: "col", kids: [paneNode("p-2", [diffTab("s-1")]), paneNode("p-3", [{ id: "t-prs", kind: "prs", title: "Pull Requests" }])], sizes: [0.5, 0.5] };
      await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), right], [0.55, 0.45]), "p-1");
      await openShellApp(page);
      await setPaneSize(page, "p-2", 480);
    } else {
      await openDiff(page, 480);
    }
    await expect(list(page)).toHaveAttribute("data-layout", "top");
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

for (const scheme of ["dark", "light"] as const) {
  for (const [layout, width] of [["wide", 800], ["narrow", 420]] as const) {
    test(`commits screenshots (${scheme}, ${layout})`, async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await mockPost("compare/commits?count=6");
      await page.emulateMedia({ colorScheme: scheme });
      await openDiff(page, width);
      await expect(page.getByTestId("diff-commits")).toBeVisible();
      await page.mouse.move(5, 5);
      await page.screenshot({ path: `${shots ?? ""}/commits-folded-${layout}-${scheme}.png` });
      await page.getByTestId("diff-commits-toggle").click();
      await page.getByTestId("diff-commit-rows").locator("[data-nav-key]").first().click();
      await expect(page.getByTestId("diff-commit")).toBeVisible();
      await expect(file(page).locator('[data-line-type="change-addition"]').first()).toBeVisible();
      await page.mouse.move(5, 5);
      await page.screenshot({ path: `${shots ?? ""}/commits-open-${layout}-${scheme}.png` });
    });
  }
}
