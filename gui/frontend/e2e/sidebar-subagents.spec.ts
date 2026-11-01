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

const card = (page: Page) => page.getByTestId("thread-info-card");
const badge = (page: Page, id: string) => row(page, `s:${id}`).getByTestId("row-bg-agents");
const lineageRow = (page: Page, id: string) => card(page).locator(`[data-testid="ti-lineage-row"][data-id="${id}"]`);
const tip = (page: Page) => page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');

async function openCard(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  if ((await page.getByTestId("thread-info-toggle").getAttribute("aria-pressed")) !== "true") await page.getByTestId("thread-info-toggle").click();
  await expect(card(page)).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("the badge counts background subagents and live child threads; a waiting lead shows its branch on line 3", async ({ page }) => {
  await mockPost("live-count");
  await openApp(page);

  // Background subagents only.
  await expect(badge(page, "s-lc-work")).toHaveText("2");
  await expect(badge(page, "s-lc-work")).toHaveAttribute("aria-label", "2 subagents");

  // The lead: its own subagent, a working child and a nested lead waiting on its worker (a finished child is not live).
  const lead = row(page, "s:s-lc-lead");
  await expect(lead).toHaveAttribute("data-section", "working");
  await expect(lead.getByTestId("row-status")).toHaveText(/^Waiting \d+(s|m)$/);
  await expect(badge(page, "s-lc-lead")).toHaveText("3");
  await expect(badge(page, "s-lc-lead")).toHaveAttribute("aria-label", "3 subagents");
  await expect(lead.getByTestId("row-detail")).toHaveCount(0);
  await expect(lead.getByTestId("row-branch")).toHaveText("fix/resize");

  // The nested lead, shown by its override: still a live row, with its own count.
  const nested = row(page, "s:s-lc-nested");
  await expect(nested).toHaveAttribute("data-section", "working");
  await expect(nested.getByTestId("row-status")).toHaveText(/^Waiting/);
  await expect(badge(page, "s-lc-nested")).toHaveText("1");
  await expect(badge(page, "s-lc-nested")).toHaveAttribute("aria-label", "1 subagent");
  await expect(nested.getByTestId("row-branch")).toHaveText("feat/sidebar");

  // Waiting on a shell alone: no badge, the shell is not a subagent; the branch on line 3.
  await expect(badge(page, "s-lc-shell")).toHaveCount(0);
  await expect(row(page, "s:s-lc-shell").getByTestId("row-branch")).toHaveText("main");

  // The badge follows the children: the working one finishes, then the nested lead's worker does.
  await mockPost("thread/status?id=s-lc-row&status=attention&reason=finished");
  await expect(badge(page, "s-lc-lead")).toHaveText("2");
  await mockPost("thread/status?id=s-lc-nested&status=attention&reason=finished");
  await expect(badge(page, "s-lc-lead")).toHaveText("1");
  await expect(badge(page, "s-lc-lead")).toHaveAttribute("aria-label", "1 subagent");
});

test("the hover card says the daemon's whole waiting reason and names the live children", async ({ page }) => {
  await mockPost("live-count");
  await openApp(page);
  await row(page, "s:s-lc-lead").hover();
  await expect(tip(page)).toHaveAttribute("data-thread-id", "s-lc-lead");
  await expect(tip(page).getByTestId("tip-waiting")).toContainText("Waiting on 2 child threads and 1 subagent");
  await expect(tip(page).getByTestId("tip-waiting-name")).toHaveText(["Inbox row layout", "Rewrite the row tests"]);

  await page.mouse.move(0, 0);
  await row(page, "s:s-lc-shell").hover();
  await expect(tip(page)).toHaveAttribute("data-thread-id", "s-lc-shell");
  await expect(tip(page).getByTestId("tip-waiting")).toHaveText("Waiting on 1 shell");

  // Today's form and the bare wake still read.
  await page.mouse.move(0, 0);
  await mockPost(`thread/status?id=s-lc-shell&status=idle&reason=${encodeURIComponent("waiting")}`);
  await row(page, "s:s-lc-shell").hover();
  await expect(tip(page).getByTestId("tip-waiting")).toHaveText("Waiting on a wake");
});

test("the card's running count equals the badge; a nested lead is a live row", async ({ page }) => {
  await mockPost("live-count");
  await openApp(page);
  await openCard(page, "s-lc-lead");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage · 3 running");
  await expect(badge(page, "s-lc-lead")).toHaveText("3");
  await expect(lineageRow(page, "s-lc-nested")).toHaveAttribute("data-state", "working");
  await expect(lineageRow(page, "s-lc-row")).toHaveAttribute("data-state", "working");
  await expect(lineageRow(page, "s-lc-done")).toHaveCount(0);

  await mockPost("thread/status?id=s-lc-row&status=attention&reason=finished");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage · 2 running");
  await expect(badge(page, "s-lc-lead")).toHaveText("2");

  await openCard(page, "s-lc-nested");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage · 1 running");
  await expect(badge(page, "s-lc-nested")).toHaveText("1");

  // No background subagents: the card's word stands alone when nothing is live, and no badge.
  await mockPost("thread/status?id=s-lc-snap&status=attention&reason=finished");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage");
  await expect(badge(page, "s-lc-nested")).toHaveCount(0);
});

test("lineage: the creator's badge counts its working and asking children, hidden ones included; a waiting child stays live", async ({ page }) => {
  await mockPost("lineage");
  await openApp(page);
  // s-l-e2e works, s-l-cookie asks for a permission (both hidden); the rest finished, failed, idle or archived.
  await expect(badge(page, "s-l-parent")).toHaveText("2");
  await openCard(page, "s-l-parent");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage · 2 running");
  // s-l-e2e becomes a lead waiting on a worker of its own: still live for its creator.
  await mockPost(`thread/status?id=s-l-e2e&status=idle&reason=${encodeURIComponent("waiting on 1 child thread")}`);
  await expect(lineageRow(page, "s-l-e2e")).toHaveAttribute("data-state", "working");
  await expect(badge(page, "s-l-parent")).toHaveText("2");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage · 2 running");
  // The permission is answered and the turn finishes: one left.
  await mockPost("thread/status?id=s-l-cookie&status=attention&reason=finished");
  await expect(badge(page, "s-l-parent")).toHaveText("1");
  await expect(card(page).getByTestId("ti-lineage-label")).toHaveText("Lineage · 1 running");
});

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
