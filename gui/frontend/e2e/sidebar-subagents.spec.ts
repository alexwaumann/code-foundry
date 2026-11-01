import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The sidebar row's live count (docs/notes/sidebar-live-count.md): line 3's Bot badge
 * counts background subagents and live child threads as one number, and the thread info
 * card's "Lineage · N running" says the same number. A waiting child counts as working, so
 * a nested lead stays a live row. A waiting thread's line 3 shows its branch (the badge
 * carries the count); its hover card says the daemon's whole reason. Over the mock's
 * POST /__mock/live-count (World.addLiveCount) and POST /__mock/lineage (World.addLineage).
 * Set SHOTS=<dir> to save the sidebar, dark and light (WebKit).
 */

const badge = (page: Page, id: string) => row(page, `s:${id}`).getByTestId("row-bg-agents");

test.beforeEach(async () => {
  await resetMock();
});

// The badge's count and its label, the waiting rows' section, status and branch, the hover card's reason and
// names, and the card's "Lineage · N running": unit-tested in src/components/sidebar/SidebarRow.test.tsx,
// TipWaiting.test.tsx, src/components/threadinfo/LineageGroup.test.tsx, src/lib/liveCount.test.ts and
// src/lib/tree.test.ts.

/** SHOTS=<dir>: the PR's screenshots, WebKit, dark and light: the sidebar with the live-count rows. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await mockPost("live-count");
    await openApp(page);
    await expect(badge(page, "s-lc-lead")).toHaveText("3");
    await page.mouse.move(800, 800);
    await page.getByTestId("sidebar").screenshot({ path: `${String(shots)}/sidebar-live-count-${scheme}.png` });
  });
}
