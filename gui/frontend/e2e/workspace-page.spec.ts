import { expect, test, type Page } from "@playwright/test";
import { mockPost, openWorkspacePage, resetMock } from "./fixtures";
import { paneOf } from "./shell";
import { openProjectsTab } from "./shell-pages";

/**
 * A workspace's page on the Projects view (docs/notes/projects-redesign-3-workspace-page.md):
 * its Projects card, Threads table and Instructions and skills, under the header PR 2
 * built (docs/notes/projects-redesign-1-index.md). The mock's projects: code-foundry
 * (repo-cf) and ghostty-playground (repo-gp) on GitHub, dotfiles (repo-dot, origin not on
 * GitHub), sketches (repo-sk) and writing (repo-wr, no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const body = (page: Page, id: string) => page.locator(`[data-testid="workspace"][data-workspace="${id}"]`);
const member = (page: Page, id: string, projectId: string) => body(page, id).locator(`[data-nav-key="m:${id}::${projectId}"]`);

async function twoWorkspaces(): Promise<{ shop: string; mono: string }> {
  const shop = (await mockPost("workspace?name=shop&projects=repo-gp,repo-cf")) as { id: string };
  const mono = (await mockPost("workspace?name=mono&projects=repo-dot&root=/Users/dev/mono&instructions=CLAUDE.md&skills=release,demo")) as { id: string };
  return { shop: shop.id, mono: mono.id };
}

// A synthetic workspace (the index rows, its projects by name with where threads start, no folder row, the instructions rows, what a thread writes showing up, Browse marketplace): src/components/projects/WorkspacePage.test.tsx ("a synthetic workspace: …", "a synthetic workspace without either…") and ProjectsIndex.test.tsx; the Settings nav's current page is SettingsPage.test.tsx's.

// A rooted workspace's folder row, its root marked missing, its instructions and skills, and View opening
// the root's CLAUDE.md as a File tab in the page's own panel: src/components/projects/WorkspacePage.test.tsx.
// Left: that tab drawn, in the page's pane (shell-model.md: a surface that belongs to no thread).
test("a rooted workspace: View opens the root's instructions as a File tab in the page's own pane, shown", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openProjectsTab(page);
  await openWorkspacePage(page, mono);
  await body(page, mono).getByTestId("workspace-instructions-open").click();
  const tab = paneOf(page, "p-1").locator('[data-testid="shell-tab"][data-kind="file"]');
  await expect(tab).toHaveText("CLAUDE.md");
  await expect(tab).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("file-tab")).toBeVisible();
});

// Start here on a project and on a rooted workspace's folder, its args and the pill moving: WorkspacePage.test.tsx. Left: the hover-only CSS.
test("a member's actions (Start here) are hidden at rest and shown on hover", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  await openProjectsTab(page);
  await openWorkspacePage(page, shop);
  const cf = member(page, shop, "repo-cf");
  await expect(cf.getByTestId("member-actions")).toHaveCSS("opacity", "0");
  await cf.hover();
  await expect(cf.getByTestId("member-actions")).toHaveCSS("opacity", "1");
  await expect(cf.getByTestId("member-make-default")).toHaveText("Start here");
});

// Add project and Remove, Open in Finder, rename, Remove workspace, New workspace, Edit instructions' steer and toast, a project named “workspace”, members by name and the keyboard: unit-tested in src/components/projects/WorkspacePage.test.tsx.

// The Threads table (columns, order, member states, the row menu with Show changes opening the page's
// panel, the chevron's tooltip, a click and Enter opening the thread), Write instructions (start, show
// while on its first turn, steer once idle) and an unregistered member opening nothing (a registered
// one its Diff tab): WorkspacePage.test.tsx. The daemon's focus intent selecting a new thread is
// src/stores/intents.test.ts's; a Diff tab drawn in a page's panel is e2e/projects.spec.ts's.

// The ⋯'s items and what its Open in list runs: WorkspacePage.test.tsx. Left: the split item drawn
// in a dropdown (not a context menu) hovers as two blocks, the › block the item's last 32px.
test("the page ⋯'s Open in Finder is the split item: › block at full height, its submenu on hover there, a click on its text reveals", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openProjectsTab(page);
  await openWorkspacePage(page, mono);
  await page.getByTestId("workspace-page-more").click();
  const split = page.getByTestId("workspace-menu-reveal");
  const more = page.getByTestId("workspace-menu-reveal-more");
  const geo = await more.evaluate((e) => {
    const item = e.closest('[role="menuitem"]') as HTMLElement;
    const a = getComputedStyle(e, "::after");
    const ib = item.getBoundingClientRect();
    const mb = e.getBoundingClientRect();
    return { w: a.width, h: a.height, itemH: `${String(item.offsetHeight)}px`, position: getComputedStyle(item).position, inside: mb.right <= ib.right && mb.left >= ib.left };
  });
  expect(geo).toEqual({ w: "32px", h: geo.itemH, itemH: geo.itemH, position: "relative", inside: true });
  await split.hover({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId("workspace-menu-reveal-menu")).toHaveCount(0);
  await more.hover();
  await expect(page.getByTestId("workspace-menu-reveal-menu")).toBeVisible();
  await split.hover({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId("workspace-menu-reveal-menu")).toHaveCount(0);
  await split.click({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId("workspace-page-more-menu")).toHaveCount(0);
});
