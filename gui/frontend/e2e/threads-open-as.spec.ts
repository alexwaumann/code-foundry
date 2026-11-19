import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, mockUrl, resetMock, threadsOpenAsTabs } from "./fixtures";

/**
 * Threads open as Panes and Single in the browser (docs/notes/threads-open-as-2-gui.md): a thread
 * pane's one header row and the height it gives back, dragging that row moves the pane, three
 * sidebar clicks leave one thread pane, and the switch dialog end to end. What the row holds per
 * mode and state, the dropdown's options, the Smart swap row, the dialog's words and the drop
 * targets are vitest's (ThreadPaneHeader, ThreadsOpenAsSettings, threadsOpenAsSwitch, modeDrop).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const thread = (id: string): Tab => ({ id: `t-${id}`, kind: "thread", thread: id });
const pane = (id: string, tabs: Tab[]): Node => ({ t: "pane", id, tabs, active: tabs[0]?.id ?? "" });
const split = (id: string, kids: Node[]): Node => ({ t: "split", id, dir: "row", kids, sizes: kids.map(() => 1 / kids.length) });

async function seed(root: Node, focus = "p-1"): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus, mru: [], drafts: [] }], current_space: "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

/** The space's stored tree by what its tabs show: `row([s-1] [prs])`. */
async function outline(): Promise<string> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  const spaces = ((await res.json()) as { state: { spaces: { id: string; root: Node | null }[] } }).state.spaces;
  const draw = (n: Node | null): string => (!n ? "" : n.t === "pane" ? `[${n.tabs.map((t) => String(t.thread || t.kind)).join(",")}]` : `${n.dir}(${n.kids.map(draw).join(" ")})`);
  return draw(spaces.find((s) => s.id === "sp-main")?.root ?? null);
}

const openAs = (value: string) => mockPost(`settings/external?layout.threads_open_as=${value}`);

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
}

async function height(page: Page, testId: string): Promise<number> {
  const b = await page.getByTestId(testId).first().boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b.height;
}

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

const row = (page: Page, id: string) => page.locator(`[data-row-key="s:${id}"]`);

async function openSettingsAt(page: Page, key: string): Promise<void> {
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByTestId("settings-page").getByText("Appearance", { exact: true }).first().click();
  const r = page.locator(`[data-setting="${key}"]`);
  await r.scrollIntoViewIfNeeded();
  await expect(r).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
});

test("under Panes a thread pane draws one 44px row, and its conversation gains the old header's height", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  await expect(page.getByTestId("thread-header")).toBeVisible();
  const strip = await height(page, "shell-tab-strip");
  const header = await height(page, "thread-header");
  const before = await height(page, "thread-pane-body");
  await openAs("panes");
  await expect(page.getByTestId("thread-pane-header")).toBeVisible();
  await expect(page.getByTestId("shell-tab-strip")).toHaveCount(0);
  await expect(page.getByTestId("thread-header")).toHaveCount(0);
  expect(await height(page, "thread-pane-header")).toBe(strip);
  expect(await height(page, "thread-pane-body")).toBe(before + header);
});

test("dragging a thread pane's row moves the pane", async ({ page }) => {
  await openAs("panes");
  await seed(split("s-r", [pane("p-1", [thread("s-1")]), pane("p-2", [{ id: "t-prs", kind: "prs" }])]));
  await openShell(page);
  const grip = await page.getByTestId("thread-pane-header").boundingBox();
  const target = await page.locator('[data-testid="shell-pane"][data-pane-id="p-2"]').boundingBox();
  if (!grip || !target) throw new Error("no boxes");
  // From the row's empty middle to the right edge of the other pane.
  await page.mouse.move(grip.x + grip.width * 0.55, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width * 0.55 + 10, grip.y + grip.height / 2 + 6, { steps: 2 });
  await page.mouse.move(target.x + target.width - 30, target.y + target.height / 2, { steps: 10 });
  await expect(page.getByTestId("shell-drop-preview")).toHaveAttribute("data-kind", "edge");
  await page.mouse.up();
  await expect.poll(outline).toBe("row([prs] [s-1])");
});

test("under Panes three sidebar clicks leave one thread pane, showing the last", async ({ page }) => {
  await openAs("panes");
  await seed(pane("p-1", [thread("s-1")]));
  await openShell(page);
  for (const id of ["s-3", "s-4", "s-5"]) {
    await row(page, id).click();
    await expect.poll(outline).toBe(`[${id}]`);
  }
  await expect(page.getByTestId("thread-pane-header")).toHaveCount(1);
});

test("the switch dialog: Cancel keeps Tabs, Switch converts with the counts it said", async ({ page }) => {
  await seed(pane("p-1", [thread("s-1"), thread("s-3"), thread("s-4")]));
  await openShell(page);
  await openSettingsAt(page, "layout.threads_open_as");
  const trigger = page.locator('[data-setting="layout.threads_open_as"]').getByRole("combobox");
  await trigger.click();
  await page.getByRole("option", { name: /^Panes/ }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Switch to Panes?");
  await expect(dialog).toContainText("2 other thread tabs in 1 space will close.");
  await page.getByTestId("confirm-cancel").click();
  await expect(trigger).toHaveAttribute("data-value", "tabs");
  expect(await outline()).toBe("[s-1,s-3,s-4]");
  await trigger.click();
  await page.getByRole("option", { name: /^Panes/ }).click();
  await expect(page.getByTestId("confirm-ok")).toBeEnabled();
  await page.getByTestId("confirm-ok").click();
  await expect(trigger).toHaveAttribute("data-value", "panes");
  await expect.poll(outline).toBe("[s-1]");
  // Back to Tabs: no dialog, nothing changes.
  await trigger.click();
  await page.getByRole("option", { name: /^Tabs/ }).click();
  await expect(trigger).toHaveAttribute("data-value", "tabs");
  await expect(dialog).toHaveCount(0);
});

for (const scheme of ["dark", "light"] as const) {
  test(`threads open as screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const dir = shots ?? "";
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    const shot = async (name: string) => {
      await page.mouse.move(1390, 890);
      await still(page);
      await page.screenshot({ path: `${dir}/${name}${suffix}.png` });
    };
    // A thread pane beside a diff, under Tabs then Panes.
    const diff = { id: "t-d", kind: "diff", thread: "s-1", params: { project: "repo-cf", worktree: "/Users/dev/src/code-foundry" } };
    await seed(split("s-r", [pane("p-1", [thread("s-1")]), pane("p-2", [diff])]));
    await openShell(page);
    await expect(page.getByTestId("thread-header")).toBeVisible();
    await shot("thread-pane-tabs");
    await openAs("panes");
    await expect(page.getByTestId("thread-pane-header")).toBeVisible();
    await shot("thread-pane-panes");
    // Two thread panes side by side.
    await seed(split("s-r", [pane("p-1", [thread("s-1")]), pane("p-2", [thread("s-3")])]));
    await expect(page.getByTestId("thread-pane-header")).toHaveCount(2);
    await shot("two-thread-panes");
    // The setting: the dropdown open, then the Smart swap row held on.
    await openAs("tabs");
    await seed(split("s-r", [pane("p-1", [thread("s-1"), thread("s-3"), thread("s-4")]), pane("p-2", [thread("s-5"), thread("s-6")])]));
    await openSettingsAt(page, "layout.threads_open_as");
    const trigger = page.locator('[data-setting="layout.threads_open_as"]').getByRole("combobox");
    await trigger.click();
    await expect(page.getByRole("option", { name: /^Single/ })).toBeVisible();
    await shot("threads-open-as-dropdown");
    await page.getByRole("option", { name: /^Panes/ }).click();
    await expect(page.getByTestId("confirm-ok")).toBeEnabled();
    await shot("switch-to-panes-dialog");
    await page.getByTestId("confirm-cancel").click();
    await trigger.click();
    await page.getByRole("option", { name: /^Single/ }).click();
    await expect(page.getByTestId("confirm-ok")).toBeEnabled();
    await shot("switch-to-single-dialog");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("smart-swap-forced")).toBeVisible();
    await page.locator('[data-setting="layout.smart_swap"]').scrollIntoViewIfNeeded();
    await shot("smart-swap-held");
  });
}
