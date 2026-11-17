import { expect, test } from "@playwright/test";
import { appPath, mockUrl, resetMock } from "./fixtures";

/**
 * Screenshots only (docs/notes/tab-naming-state.md): a thread whose name is being regenerated
 * shows it muted and italic in its tab, as in its sidebar row and the row under its diff's strip.
 * What renders when is vitest's (components/shell/PaneTabStrip.test.tsx, linkedTabs.test.tsx).
 * SHOTS=<dir> (WebKit, dark and light).
 */

const FEAT = "/Users/dev/src/code-foundry.worktrees/feat-sidebar";

/** s-3's and s-4's threads (s-4 active), beside s-4's diff. */
const STATE = {
  v: 1,
  spaces: [
    {
      id: "sp-main",
      name: "Main",
      root: {
        t: "split",
        id: "s-r",
        dir: "row",
        kids: [
          { t: "pane", id: "p-l", tabs: [{ id: "t-s-3", kind: "thread", thread: "s-3" }, { id: "t-s-4", kind: "thread", thread: "s-4" }], active: "t-s-4" },
          { t: "pane", id: "p-r", tabs: [{ id: "t-diff", kind: "diff", thread: "s-4", params: { project: "repo-cf", worktree: FEAT }, title: "Diff" }], active: "t-diff" },
        ],
        sizes: [0.55, 0.45],
      },
      focus: "p-l",
      mru: [],
    },
  ],
  current_space: "sp-main",
  default_space: "sp-main",
};

test.beforeEach(async () => {
  await resetMock();
});

for (const scheme of ["dark", "light"] as const) {
  test(`tab naming screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/tab-naming-${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    expect((await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(STATE) })).ok).toBe(true);
    expect((await fetch(`${mockUrl}/__mock/thread/naming?id=s-4`, { method: "POST" })).ok).toBe(true);
    await page.setViewportSize({ width: 1300, height: 640 });
    await page.goto(`${appPath}&shell=1`);
    await expect(page.getByTestId("shell-grid")).toBeVisible();
    await expect(page.locator('[data-testid="shell-tab"][data-tab-id="t-s-4"]')).toBeVisible();
    await expect(page.getByTestId("shell-linked-row-name")).toBeVisible();
    await expect(page.locator('[data-testid="thread-name"][data-provisional]').first()).toBeVisible();
    await page.mouse.move(0, 630);
    await page.screenshot({ path: at("strip"), clip: { x: 0, y: 0, width: 1300, height: 640 } });
  });
}
