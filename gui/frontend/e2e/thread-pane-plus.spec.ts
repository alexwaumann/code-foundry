import { expect, test, type Page } from "@playwright/test";
import { appPath, CF, mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * A thread pane's "+" in the browser (docs/notes/thread-pane-plus-menu.md): under Panes, New
 * thread beside opens a composer in a new pane on the right that takes the focus, the thread
 * staying where it was. The menu's contents per mode, its name and the verb it runs are vitest's
 * (components/shell/threadPanePlus.test.tsx); the daemon's rule is Go's (TestNewThreadBeside).
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light); they find the "+" by its test id,
 * so the same steps shoot the menu before the change.
 */

type Tab = Record<string, unknown> & { id: string };
type Node = { t: "pane"; id: string; tabs: Tab[]; active: string } | { t: "split"; id: string; dir: "row" | "col"; kids: Node[]; sizes: number[] };

const pane = (id: string, tabs: Tab[]): Node => ({ t: "pane", id, tabs, active: tabs[0]?.id ?? "" });
const thread: Tab = { id: "t-s-1", kind: "thread", thread: "s-1" };
const diff: Tab = { id: "t-diff-s-1", kind: "diff", thread: "s-1", params: { project: "repo-cf", worktree: CF }, title: "Diff" };

async function seed(root: Node): Promise<void> {
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus: "p-1", mru: [], drafts: [] }], current_space: "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

/** The space's stored tree by what its tabs show: `row([s-1] [compose])`. */
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
  await expect(page.getByTestId("thread-pane-header").first()).toBeVisible();
}

/** Waits for the finite animations (the menu's fade and zoom in) to end. */
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

test.beforeEach(async () => {
  await resetMock();
});

test("under Panes, New thread beside opens a composer in a new pane on the right that takes the focus", async ({ page }) => {
  await openAs("panes");
  await seed(pane("p-1", [thread]));
  await openShell(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("menuitem", { name: "New thread beside" }).click();
  await expect.poll(outline).toBe("row([s-1] [compose])");
  const composerPane = page.locator('[data-testid="shell-pane"]').filter({ has: page.locator('[data-testid="thread-pane-header"][data-kind="compose"]') });
  await expect(composerPane.locator(":focus")).toHaveCount(1);
});

/** SHOTS=<dir>: the open menu of a thread pane's "+" under Panes and Single, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`thread pane plus screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/thread-pane-plus-${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    for (const m of ["panes", "single"]) {
      await openAs(m);
      await seed({ t: "split", id: "s-r", dir: "row", kids: [pane("p-1", [thread]), pane("p-2", [diff])], sizes: [0.6, 0.4] });
      await openShell(page);
      await page.getByTestId("thread-pane-header").getByTestId("pane-plus").click();
      await expect(page.getByTestId("pane-plus-menu")).toBeVisible();
      await still(page);
      await page.screenshot({ path: at(m) });
      await page.keyboard.press("Escape");
    }
  });
}
