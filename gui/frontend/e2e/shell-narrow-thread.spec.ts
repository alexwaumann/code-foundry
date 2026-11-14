import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, mockUrl, resetMock, setZoom } from "./fixtures";

/**
 * A thread's pane narrower than a thread's minimum (docs/notes/shell-24d-spec-differences.md, 2):
 * at 200% in a 1100x720 window the pane grid is under a thread's 360 layout px and the focused
 * thread's pane never folds, so the composer's footer stacks and its dock is taller than the
 * conversation's box. The box clips it: the pane's header (its place, thread info, the menu)
 * stays on top and usable. Geometry only a browser shows; what the header holds is vitest's.
 * SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

type Tab = Record<string, unknown> & { id: string };

async function seed(): Promise<void> {
  const tab: Tab = { id: "t-badge", kind: "thread", thread: "s-ny-badge" };
  const root = { t: "pane", id: "p-1", tabs: [tab], active: tab.id };
  const state = { v: 1, spaces: [{ id: "sp-main", name: "Main", root, focus: "p-1", mru: [], drafts: [] }], current_space: "sp-main", default_space: "sp-main", threads: {} };
  const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
  expect(res.ok).toBe(true);
}

/** Wait out finite animations; a spinner runs for ever. */
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

async function narrow(page: Page): Promise<void> {
  await seed();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
  await expect(page.getByTestId("shell-grid")).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 720 });
  await setZoom(page, 200);
  // s-ny-badge asks for a permission: in a pane this short it is one line on the composer.
  await expect(page.getByTestId("thread-pane").getByRole("textbox", { name: "Prompt" })).toBeVisible();
  await still(page);
}

test.beforeEach(async () => {
  await resetMock();
  await mockPost("needs-you");
});

test("at 200% in a 1100x720 window the composer never covers the thread pane's header", async ({ page }) => {
  await narrow(page);
  const pane = page.getByTestId("thread-pane");
  // The dock is taller than the conversation's box: what this is about.
  const dock = await pane.locator(".dock").boundingBox();
  const body = await pane.getByTestId("thread-pane-body").boundingBox();
  expect(dock?.height ?? 0).toBeGreaterThan(body?.height ?? 0);
  for (const id of ["thread-title-bar", "thread-info-toggle", "thread-header-menu-trigger"]) {
    const on = await pane.getByTestId(id).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at !== null && el.contains(at);
    });
    expect(on, `${id} is under the pointer where it is drawn`).toBe(true);
  }
  // And usable: the menu opens from it.
  await pane.getByTestId("thread-header-menu-trigger").click();
  await expect(page.getByTestId("thread-header-menu")).toBeVisible();
});

/** SHOTS=<dir>: the narrow thread pane at 200% in a 1100x720 window, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`narrow thread pane at 200% screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await narrow(page);
    await page.screenshot({ path: `${shots ?? ""}/narrow-thread-200${scheme === "light" ? "-light" : ""}.png` });
  });
}
