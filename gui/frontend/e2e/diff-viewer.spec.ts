import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * The Diff tab where only a real browser can tell (docs/notes/diff-viewer-2.md): the file list
 * moving between rail and top with the panel's real width, and the list scrolling inside
 * itself. Everything else is src/components/diff/DiffView.test.tsx. Set SHOTS=<dir> to save the
 * pull request's screenshots (WebKit, dark and light, wide and narrow).
 */

const list = (page: Page) => page.getByTestId("diff-file-list");
const column = (page: Page) => page.getByTestId("diff-list-column");
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

  const rail = await column(page).boundingBox();
  const diff = await file(page).boundingBox();
  if (!rail || !diff) throw new Error("no boxes");
  expect(Math.abs(rail.x + rail.width - diff.x)).toBeLessThanOrEqual(1);
  expect(rail.height).toBeGreaterThan(400);

  // The window stays as wide as it was: only the panel narrows.
  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(file(page)).toHaveAttribute("data-path", "README.md");
  const top = await column(page).boundingBox();
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
  await panelWidth(page, 480);
  await expect(list(page)).toHaveAttribute("data-layout", "top");
  await expect(section).toHaveAttribute("data-open", "true");
  expect(await rows.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(90);
  expect((await file(page).boundingBox())?.height ?? 0).toBeGreaterThan(180);
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
