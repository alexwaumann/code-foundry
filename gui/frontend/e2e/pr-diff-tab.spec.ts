import { expect, test, type Page } from "@playwright/test";
import { resetMock } from "./fixtures";
import { layoutState, paneOf, type LayoutNode } from "./shell";
import { openPrBesidePage, PR_PANE, SLUG } from "./shell-pages";

/**
 * A pull request's diff in a tab of its own (components/diff/PrDiffView.tsx) against the mock's
 * three-file diff (mock/prDiff.ts): where openPullRequestDiff puts it, that a second call finds it,
 * and that its code scrolls. What it shows in each state is PrDiffView.test.tsx's. Set
 * SHOTS=<dir> to save screenshots (the tab wide and narrow, and the pull request's Code tab).
 */

test.beforeEach(async () => {
  await resetMock();
});

const openDiff = (page: Page) => page.evaluate(`__cfModule("/src/stores/prDiffPanel.ts").then((m) => m.openPullRequestDiff({ slug: "${SLUG}", number: 145 }))`);

/** The tabs of the pull request's pane, in strip order, and the one it shows. */
async function prPaneTabs(): Promise<{ kinds: string[]; active: string }> {
  const find = (n: LayoutNode | null): Extract<LayoutNode, { t: "pane" }> | null => (!n ? null : n.t === "pane" ? (n.id === PR_PANE ? n : null) : n.kids.map(find).find((x) => x) ?? null);
  const pane = find((await layoutState()).spaces[0]?.root ?? null);
  const tabs = (pane?.tabs ?? []) as { id: string; kind: string }[];
  return { kinds: tabs.map((t) => t.kind), active: tabs.find((t) => t.id === pane?.active)?.kind ?? "" };
}

test("opens beside the pull request's tab, a second open shows that one, and the diff scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openPrBesidePage(page, 145, 760);
  await openDiff(page);
  await expect.poll(prPaneTabs).toEqual({ kinds: ["pullrequest", "prdiff"], active: "prdiff" });
  const pane = paneOf(page, PR_PANE);
  await expect(pane.getByTestId("pr-diff")).toHaveAttribute("data-layout", "rail");
  await expect(pane.locator('[data-testid="shell-tab"][data-kind="prdiff"]')).toContainText("Diff #145");

  // Back on the pull request, the same call shows the diff tab it has: no second one.
  await pane.locator('[data-testid="shell-tab"][data-kind="pullrequest"] [role="tab"]').click();
  await expect.poll(prPaneTabs).toEqual({ kinds: ["pullrequest", "prdiff"], active: "pullrequest" });
  await openDiff(page);
  await expect.poll(prPaneTabs).toEqual({ kinds: ["pullrequest", "prdiff"], active: "prdiff" });

  // The longest file's code scrolls inside the tab, under its header.
  await pane.getByRole("option").filter({ hasText: "greeting.ts" }).click();
  const code = pane.getByTestId("diff-code");
  await expect(code.locator("[data-line-type='change-addition']").first()).toBeVisible();
  const header = await pane.getByTestId("file-header").boundingBox();
  const box = await code.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 100);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => code.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await pane.getByTestId("file-header").boundingBox()).toEqual(header);
});

for (const scheme of ["dark", "light"] as const) {
  test(`pull request diff tab screenshots (${scheme})`, async ({ page }) => {
    const dir = process.env.SHOTS;
    test.skip(!dir, "SHOTS=<dir> only");
    await page.emulateMedia({ colorScheme: scheme });
    const pane = paneOf(page, PR_PANE);
    for (const [name, width] of [
      ["wide", 760],
      ["narrow", 480],
    ] as const) {
      await resetMock();
      await openPrBesidePage(page, 145, width);
      // Before: the pull request's own Code tab.
      await page.getByTestId("pr-tab-code").click();
      await expect(page.getByTestId("pr-code-diff").locator("[data-line-type='change-addition']").first()).toBeVisible();
      await page.screenshot({ path: `${dir ?? ""}/before-code-tab-${name}-${scheme}.png` });
      await openDiff(page);
      await expect(pane.getByTestId("pr-diff")).toHaveAttribute("data-layout", name === "wide" ? "rail" : "menu");
      if (name === "wide") await pane.getByRole("option").filter({ hasText: "greeting.ts" }).click();
      else {
        await pane.getByTestId("pr-diff-files").click();
        await page.getByTestId("pr-diff-files-menu").getByRole("option").filter({ hasText: "greeting.ts" }).click();
      }
      await expect(pane.getByTestId("pr-diff-file")).toHaveAttribute("data-path", "gui/frontend/src/lib/greeting.ts");
      await expect(pane.getByTestId("diff-code").locator("[data-line-type='change-addition']").first()).toBeVisible();
      await page.screenshot({ path: `${dir ?? ""}/after-diff-tab-${name}-${scheme}.png` });
      if (name === "narrow") {
        await pane.getByTestId("pr-diff-files").click();
        await expect(page.getByTestId("pr-diff-files-menu")).toBeVisible();
        // Its fade in done, so the shot is of the menu, not of it half drawn.
        await page.getByTestId("pr-diff-files-menu").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        await page.screenshot({ path: `${dir ?? ""}/after-diff-tab-${name}-menu-${scheme}.png` });
      }
    }
  });
}
