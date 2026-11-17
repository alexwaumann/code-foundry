import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * SHOTS=<dir>: the PR's screenshots of thread tabs' status dots (docs/notes/tab-status-dots.md),
 * WebKit, dark and light: two panes of thread tabs, one per status (idle, working, permission,
 * done, error, waiting). Which status gets which dot is vitest's (components/shell/PaneTabStrip.test.tsx).
 */

const thread = (id: string) => ({ id: `t-${id}`, kind: "thread", thread: id });
const pane = (id: string, ids: string[]) => ({ t: "pane", id, tabs: ids.map(thread), active: `t-${ids[0] ?? ""}` });

async function seed(): Promise<void> {
  await mockPost("status-kinds");
  await mockPost("live-count");
  const root = {
    t: "split",
    id: "s-r",
    dir: "row",
    kids: [pane("p-1", ["s-k-idle", "s-k-busy", "s-k-approval"]), pane("p-2", ["s-k-finished", "s-k-error", "s-lc-lead"])],
    sizes: [0.5, 0.5],
  };
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus: "p-1", mru: [] }], current_space: "sp-main", default_space: "sp-main" };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

async function still(page: Page): Promise<void> {
  // Finite ones only: a spinner runs for ever.
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

for (const scheme of ["dark", "light"] as const) {
  test(`tab status dot screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await seed();
    await page.goto(`${appPath}&shell=1`);
    await expect(page.getByTestId("shell-tab")).toHaveCount(6);
    await page.mouse.move(700, 880);
    await still(page);
    await page.screenshot({ path: `${shots ?? ""}/tab-status-dots${suffix}.png` });
    // The two strips, close up.
    await page.screenshot({ path: `${shots ?? ""}/tab-status-dots-strips${suffix}.png`, clip: { x: 250, y: 56, width: 1140, height: 44 }, scale: "device" });
  });
}
