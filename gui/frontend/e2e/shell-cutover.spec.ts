import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * The cutover (docs/notes/shell-20-cutover.md): the window shell is the default window, and
 * before it first draws it runs the first-load import of the classic window's stored panels
 * once. What needs the browser: the real localStorage strings reaching the daemon, the pane area
 * while the import fails, a reload not importing again, and the keyboard staying in a dialog the
 * user opened while the first draw waited. The import's rules are Go's (internal/layout
 * legacy_test.go), the gate's states vitest's (shell/legacyImport.test.tsx), the key table's
 * keys/shellKeys.test.ts and internal/command TestShellKeyTable.
 * SHOTS=<dir> for the PR's screenshots (WebKit, 1400x900, dark and light).
 */

// What a classic window persisted: a thread's side panel with a file and its bottom panel open.
const PANEL = JSON.stringify({ state: { byKey: { "thread:s-1": { open: true, groups: [{ tabs: [{ id: "files?path=%2Fa", kind: "files", title: "a", params: { path: "/a" } }], activeTabId: null }] } } }, version: 5 });
const BOTTOM = JSON.stringify({ state: { byKey: { "thread:s-1": { open: true, height: 240 } } }, version: 1 });

interface MockLayout {
  legacyImported: boolean;
  imports: { panelJson: string; bottomJson: string }[];
}

async function mockLayout(): Promise<MockLayout> {
  return (await (await fetch(`${mockUrl}/__mock/layout`)).json()) as MockLayout;
}

/** Opens the app with no shell flag (the default) and the classic stores in its localStorage. */
async function openWithClassicStores(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(
    ([panel, bottom]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("code-foundry.panel", panel ?? "");
      localStorage.setItem("code-foundry.bottom", bottom ?? "");
    },
    [PANEL, BOTTOM],
  );
  await page.goto(appPath);
}

test.beforeEach(async () => {
  await resetMock();
});

test("first load: the stored panels go to the daemon once, the window draws one empty space; a reload imports nothing", async ({ page }) => {
  await openWithClassicStores(page);
  await expect(page.getByTestId("shell-empty-space")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("shell-pane")).toHaveCount(0);
  const after = await mockLayout();
  expect(after.legacyImported).toBe(true);
  expect(after.imports).toHaveLength(1);
  // What localStorage holds goes as it is: the classic panel store (still loaded, until PR 21)
  // has migrated it to its current version on load, the same tabs.
  const sent = after.imports[0];
  const panel = JSON.parse(sent?.panelJson ?? "{}") as { state: { byKey: Record<string, { groups: { tabs: { params: Record<string, string> }[] }[] }> } };
  expect(panel.state.byKey["thread:s-1"]?.groups[0]?.tabs.map((t) => t.params.path)).toEqual(["/a"]);
  expect(sent?.bottomJson).toBe(BOTTOM);
  // The classic window's keys stay (a downgraded window still finds them).
  expect(await page.evaluate(() => [localStorage.getItem("code-foundry.panel"), localStorage.getItem("code-foundry.bottom")])).toEqual([sent?.panelJson, BOTTOM]);

  await page.reload();
  await expect(page.getByTestId("shell-empty-space")).toBeVisible();
  expect((await mockLayout()).imports).toHaveLength(1);
});

test("a failed import says so in the pane area; Try again draws the window", async ({ page }) => {
  await mockPost("layout/import?fail=1&error=the+daemon+is+restarting");
  await openWithClassicStores(page);
  const notice = page.getByTestId("shell-notice");
  await expect(notice).toHaveAttribute("data-notice", "import-failed");
  await expect(notice.getByTestId("shell-notice-error")).toContainText("the daemon is restarting");
  await expect(page.getByTestId("shell-empty-space")).toHaveCount(0);
  await notice.getByTestId("shell-import-retry").click();
  await expect(page.getByTestId("shell-empty-space")).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect((await mockLayout()).imports).toHaveLength(2);
});

test("the palette opened while the first draw waits keeps the keyboard when the composer mounts", async ({ page }) => {
  await mockPost("layout/import?delay=1500");
  await openWithClassicStores(page);
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await expect(page.getByTestId("shell-empty-space")).toBeVisible();
  await page.keyboard.type("foundry");
  await expect(palette.locator("input")).toHaveValue("foundry");
  await page.keyboard.press("Meta+1");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
});

/** SHOTS=<dir>: the first load after the import (one empty space), the keyboard help's new keys, the failed import; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`cutover screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await openWithClassicStores(page);
    await expect(page.getByTestId("shell-empty-space")).toBeVisible();
    await page.mouse.move(700, 880);
    await page.screenshot({ path: at("cutover-first-load") });

    await page.keyboard.press("Meta+Slash");
    await page.getByTestId("help-tab-shortcuts").click();
    await expect(page.getByTestId("help-shortcuts")).toBeVisible();
    await expect(page.locator('[data-help-command="pane.focus.left"]')).toBeVisible();
    await page.screenshot({ path: at("cutover-keyboard-help") });
    // The View section (back and forward, the thread's diff and info, full screen, the file finder) is below the fold.
    await page.getByTestId("help-shortcuts").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('[data-help-command="view.thread-diff"]')).toBeInViewport();
    await page.screenshot({ path: at("cutover-keyboard-help-view") });
    await page.keyboard.press("Escape");

    await resetMock();
    await mockPost("layout/import?fail=1&error=unavailable%3A+connection+refused");
    await page.reload();
    await expect(page.getByTestId("shell-notice")).toBeVisible();
    await page.screenshot({ path: at("cutover-import-failed") });
  });
}
