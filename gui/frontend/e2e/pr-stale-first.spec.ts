import { expect, test, type Page } from "@playwright/test";
import { mockPost, resetMock } from "./fixtures";
import { paneNode } from "./shell";
import { openLayout, openPrBesidePage, PRS_TAB } from "./shell-pages";

/**
 * A pull request answered from a stale copy (docs/notes/pr-detail-stale-first.md): what only a
 * browser shows, the surface's scroll staying put when the fetch lands (in a pull request's tab). The tab, the cue, the
 * banner and the readiness: src/components/pr/PullRequestSurface.test.tsx. Set SHOTS=<dir> to
 * save the screenshots of the cue and of the Pull Requests page before its first poll.
 */

const SLUG = "alexwaumann/code-foundry";
const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

/** Opens #145 from the page's rows and shows its tab (it opens behind the page: prs.spec.ts's shell gap). */
async function openPr145(page: Page): Promise<void> {
  await page.getByTestId("prs-authored").locator("[data-nav-key]").filter({ hasText: "#145" }).click();
  await page.locator('[data-testid="shell-tab"][data-kind="pullrequest"] [role="tab"]').click();
  await expect(page.getByTestId("pr-surface")).toBeVisible();
}

test("the fetch landing behind a stale copy leaves the panel where it was scrolled", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 500 });
  await openPrBesidePage(page, 145);
  await page.getByTestId("pr-tab-activity").click();
  const scrollTop = (to = -1) =>
    page.getByTestId("pr-surface").evaluate((surface, y) => {
      let el: Element = surface;
      while (!(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) {
        if (!el.parentElement) throw new Error("the surface does not scroll");
        el = el.parentElement;
      }
      if (y >= 0) el.scrollTop = y;
      return el.scrollTop;
    }, to);
  const before = await scrollTop(240);
  expect(before).toBeGreaterThan(100);

  await mockPost(`gh/pr-stale?repo=${SLUG}&number=145&ms=100&body=Added%20while%20the%20copy%20was%20stale`);
  await mockPost(`gh/pr-comment?repo=${SLUG}&number=145&body=A%20new%20comment`); // the event that brings the read of the copy
  await expect(page.getByTestId("pr-surface")).toContainText("A new comment");
  const landed = () =>
    page.evaluate(async () => {
      const w = window as unknown as { __cfModule: (p: string) => Promise<{ pullRequestDetailResource: { store: { getState: () => { entries: Record<string, { data: { body: string } | null } | undefined> } } } }> };
      const { pullRequestDetailResource } = await w.__cfModule("/src/stores/gh.ts");
      const d = pullRequestDetailResource.store.getState().entries["alexwaumann/code-foundry#145"]?.data;
      return d?.body.includes("Added while the copy was stale") ?? false;
    });
  await expect.poll(landed).toBe(true);
  expect(await scrollTop()).toBe(before);
  await expect(page.getByTestId("pr-tab-activity")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("pr-loading")).toHaveCount(0);
});

for (const scheme of ["dark", "light"] as const) {
  test(`stale-first screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });

    await mockPost("gh/dashboard-cold");
    await openLayout(page, paneNode("p-1", [PRS_TAB]), "p-1");
    await expect(page.getByTestId("prs-loading")).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/prs-first-poll${suffix}.png` });
    await mockPost("gh/dashboard-warm");
    await expect(page.getByTestId("prs-loading")).toHaveCount(0);

    await mockPost(`gh/pr-stale?repo=${SLUG}&number=145&ms=-1`);
    await openPr145(page);
    await expect(page.getByTestId("pr-updating")).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/pr-updating${suffix}.png` });
  });
}
