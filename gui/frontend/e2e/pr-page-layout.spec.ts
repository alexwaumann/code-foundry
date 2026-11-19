import { expect, test, type Page } from "@playwright/test";
import { resetMock } from "./fixtures";
import { openPrBesidePage, showPr } from "./shell-pages";

/**
 * SHOTS=<dir> only: the pull request page in its states for the PR body, dark and light, in a
 * wide pane (900px, the details as a side column) and a narrow one (420px, the default panel).
 * What each state shows is unit-tested (src/components/pr/PullRequestSurface.test.tsx); the
 * geometry is checked in pr-panel.spec.ts.
 */

const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
  await page.mouse.move(2, 2);
  await page.screenshot({ path: `${shots ?? ""}/${name}.png` });
}

test.beforeEach(async () => {
  await resetMock();
});

// #142 ready, #160 changes requested, #163 checks running, #164 auto-merge on, #138 merged.
const STATES = [142, 160, 163, 164, 138];

for (const scheme of ["dark", "light"] as const) {
  for (const [label, width] of [
    ["wide", 900],
    ["narrow", 420],
  ] as const) {
    test(`states, ${label}, ${scheme} (screenshots)`, async ({ page }) => {
      test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await openPrBesidePage(page, STATES[0] ?? 142, width);
      for (const n of STATES) {
        await showPr(page, n);
        await expect(page.getByTestId("pr-tab-overview")).toBeVisible();
        await shot(page, `pr-${String(n)}-${label}-${scheme}`);
      }
    });
  }

  test(`the ⋯ menu and the stale strip, ${scheme} (screenshots)`, async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await openPrBesidePage(page, 142, 420);
    await page.getByTestId("pr-menu-button").click();
    await expect(page.getByTestId("pr-menu")).toBeVisible();
    await shot(page, `pr-menu-${scheme}`);
    await page.keyboard.press("Escape");
    // A copy whose last fetch failed, as the daemon serves it (the mock has no control for one).
    await page.evaluate(`__cfModule("/src/stores/gh.ts").then((m) => {
      const key = m.pullRequestKey("alexwaumann/code-foundry", 142);
      const e = m.pullRequestDetailResource.store.getState().entries[key];
      m.pullRequestDetailResource.set(key, { data: { ...e.data, fetchFailed: true, fetchedAtMs: Date.now() - 5 * 60_000, lastError: "github graphql: 502 Bad Gateway" } });
    })`);
    await expect(page.getByTestId("pr-stale")).toBeVisible();
    await shot(page, `pr-stale-${scheme}`);
  });
}
