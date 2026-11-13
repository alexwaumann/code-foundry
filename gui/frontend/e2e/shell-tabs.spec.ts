import { expect, test, type Page } from "@playwright/test";
import { resetMock } from "./fixtures";
import { openShellApp, paneNode, paneOf, rowNode, seedLayout, threadTab } from "./shell";
import { diffTab, keyboardPane, stripTabs } from "./shell-surfaces";

/**
 * A pane's tabs and the keyboard, what the side panel's specs checked of its strip and that the
 * shell keeps (panel.spec.ts and panel-split.spec.ts were rewritten here; the rest of them is
 * shell-drag, shell-grid and shell-fullscreen's): the browser's own keys on the tab buttons, the
 * palette handing the keyboard back, and cmd+w closing a pane's last tab with the keyboard going
 * back to what had it. Which tab a click or a close focuses is vitest's
 * (components/shell/PaneTabStrip.test.tsx, shell/closeTab.test.ts).
 */

const prs = { id: "t-prs", kind: "prs", title: "Pull Requests" };

test.beforeEach(async () => {
  await resetMock();
});

/** Records, for every cmd+w keydown, whether something called preventDefault on it. */
async function recordCmdW(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cmdw: boolean[] };
    w.__cmdw = [];
    // Capture phase, read after dispatch: a handler may stop propagation.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.metaKey && e.key.toLowerCase() === "w") {
          setTimeout(() => {
            w.__cmdw.push(e.defaultPrevented);
          }, 0);
        }
      },
      true,
    );
  });
}

const cmdW = (page: Page): Promise<boolean[]> => page.evaluate(() => (window as unknown as { __cmdw: boolean[] }).__cmdw);

test("tabs are keyboard reachable: arrows move, Enter and Space activate, Tab reaches the ×", async ({ page }) => {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [diffTab("s-1"), prs])]), "p-2");
  await openShellApp(page);
  const tabs = stripTabs(paneOf(page, "p-2"));
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(paneOf(page, "p-2").getByTestId("prs-page")).toBeVisible();
  await tabs.nth(0).focus();
  await page.keyboard.press(" ");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  // The active tab's × is next in the tab order.
  await page.keyboard.press("Tab");
  await expect(paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-active] [data-testid="shell-tab-close"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs).toHaveCount(1);
  await expect(paneOf(page, "p-2").getByTestId("prs-page")).toBeVisible();
});

test("the palette hands the keyboard back to the pane it was opened from", async ({ page }) => {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [diffTab("s-1")])]), "p-1");
  await openShellApp(page);
  await page.locator('[data-nav-key="f:README.md"]').click();
  await expect(paneOf(page, "p-2")).toHaveAttribute("data-focused", "true");
  await expect.poll(() => keyboardPane(page)).toBe("p-2");

  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => keyboardPane(page)).toBe("p-2");
  await expect(paneOf(page, "p-2")).toHaveAttribute("data-focused", "true");
});

test("cmd+w on a pane's last tab is handled and closes the pane; the keyboard goes back to the Pull Requests list", async ({ page }) => {
  await seedLayout(rowNode([paneNode("p-1", [prs]), paneNode("p-2", [diffTab("s-1")])]), "p-1");
  await openShellApp(page);
  await recordCmdW(page);
  // The Pull Requests page has the keyboard (its tab pressed), then the diff's pane.
  await paneOf(page, "p-1").getByRole("tab").click();
  await page.getByTestId("prs-list").focus();
  await expect(page.getByTestId("prs-list")).toBeFocused();
  await paneOf(page, "p-2").getByRole("tab").click();
  await expect(paneOf(page, "p-2")).toHaveAttribute("data-focused", "true");

  await page.keyboard.press("Meta+w");
  await expect(paneOf(page, "p-2")).toHaveCount(0);
  await expect.poll(() => cmdW(page)).toEqual([true]);
  await expect(page.getByTestId("prs-list")).toBeFocused();
  // Its keys work at once.
  await page.keyboard.press("j");
  await expect(page.getByTestId("prs-list").locator('[aria-selected="true"]')).toHaveCount(1);
});

test("a gutter takes the keyboard and its arrow keys move it; a double click evens its panes", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [diffTab("s-1")])], [0.6, 0.4]), "p-1");
  await openShellApp(page);
  const width = async () => Math.round((await paneOf(page, "p-2").boundingBox())?.width ?? 0);
  const before = await width();
  const gutter = page.getByTestId("shell-gutter");
  await gutter.focus();
  await expect(gutter).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBeGreaterThan(before);
  // A double click shares the two panes evenly.
  await gutter.dblclick();
  const left = async () => Math.round((await paneOf(page, "p-1").boundingBox())?.width ?? 0);
  await expect.poll(async () => Math.abs((await left()) - (await width()))).toBeLessThanOrEqual(1);
});
