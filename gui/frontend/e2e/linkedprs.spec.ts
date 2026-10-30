import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A thread's linked pull requests (docs/notes/linked-prs.md) from Claude's pr-link records,
 * linked here through POST /__mock/link-pr: the sidebar row's tag and the row tooltip. The
 * Linked PRs surface is gone (docs/notes/thread-header-crumb.md): the thread info card's
 * pull request rows list them, and the tag's click shows the card. Set SHOTS=<dir> to save
 * the notes' screenshots (WebKit, 1400x900, dark and light).
 */

const CF = "alexwaumann/code-foundry";
const MIN = 60_000;

const card = (page: Page) => page.getByTestId("thread-info-card");

async function link(thread: string, number: number, agoMs = 0, slug = CF): Promise<void> {
  const res = (await mockPost(`link-pr?thread=${thread}&slug=${encodeURIComponent(slug)}&number=${String(number)}&ago=${String(agoMs)}`)) as { added: boolean };
  expect(res.added).toBe(true);
}

/**
 * s-1's links in first-seen order: merged #138, draft #145 (failing), open #147 (failing),
 * open #142 (passing). Newest first, the list shows 142, 147, 145, 138.
 */
async function linkFour(): Promise<void> {
  await link("s-1", 138, 3 * 60 * MIN);
  await link("s-1", 145, 2 * 60 * MIN);
  await link("s-1", 147, 40 * MIN);
  await link("s-1", 142, 5 * MIN);
}

/** The thread info card shows for `thread`, which is selected. */
async function expectCard(page: Page, thread = "s-1"): Promise<void> {
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", thread);
  await expect(page.getByTestId("thread-info-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(card(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          w.__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  });
});

test("hidden without links; a link brings the sidebar tag, and the header shows none", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("pane-actions")).toBeVisible();
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveCount(0);

  await link("s-1", 142);
  // One open PR: its bare number (docs/notes/sidebar-pr-tag.md).
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveText("142");
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveAttribute("data-state", "open");
  // The header has no PR button: the card's rows are the pane's pull requests.
  await expect(page.getByTestId("pane-linked-pr")).toHaveCount(0);
  await expect(page.getByTestId("pane-linked-prs")).toHaveCount(0);

  await link("s-1", 147);
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveText("2 PRs");
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveAttribute("data-tone", "success");
  // Other threads have none.
  await expect(row(page, "s:s-2").getByTestId("row-linked-prs")).toHaveCount(0);
});

test("the sidebar tag shows the card for its thread and selects it", async ({ page }) => {
  await link("s-2", 12, 10 * MIN, "alexwaumann/ghostty-playground");
  await link("s-2", 147, 2 * MIN);
  await openApp(page);
  await row(page, "s:s-1").click();
  await row(page, "s:s-2").getByTestId("row-linked-prs").click();
  await expectCard(page, "s-2");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("panel-body")).toHaveCount(0);
});

/**
 * The sidebar tag's states (docs/notes/sidebar-pr-tag.md): s-1 open #142, s-3 draft #145,
 * s-4 merged #138, s-5 all three plus closed #131. #131 is on no dashboard, so it counts
 * as unknown until its detail is read (the thread info card reads it); then it drops out.
 */
async function linkStates(): Promise<void> {
  await link("s-1", 142, 10 * MIN);
  await link("s-3", 145, 10 * MIN);
  await link("s-4", 138, 10 * MIN);
  for (const n of [138, 145, 142, 131]) await link("s-5", n, 10 * MIN);
  // #147 is on no dashboard: unknown until something reads its detail.
  await link("s-2", 147, 10 * MIN);
}

test("the sidebar tag: one PR's state and number, a count in the worst state's tone, closed ones left out", async ({ page }) => {
  await linkStates();
  await openApp(page);
  const tag = (thread: string) => row(page, `s:${thread}`).getByTestId("row-linked-prs");
  await expect(tag("s-1")).toHaveText("142");
  await expect(tag("s-1")).toHaveAttribute("data-state", "open");
  await expect(tag("s-3")).toHaveText("145");
  await expect(tag("s-3")).toHaveAttribute("data-state", "draft");
  await expect(tag("s-4")).toHaveText("138");
  await expect(tag("s-4")).toHaveAttribute("data-state", "merged");
  // #131 not read yet: it counts.
  await expect(tag("s-5")).toHaveText("4 PRs");
  await expect(tag("s-5")).toHaveAttribute("data-tone", "draft");
  // The tooltip names the one PR's state and title.
  await tag("s-1").hover();
  await expect(page.getByTestId("row-linked-prs-tip").first()).toContainText("Open · feat(gui): virtualized sidebar tree with thread rows");
  await expect(page.getByTestId("thread-tooltip")).toHaveCount(0);
  // The card on s-5 reads #131's detail: closed, so it leaves the count.
  await tag("s-5").click();
  await expectCard(page, "s-5");
  await expect(tag("s-5")).toHaveText("3 PRs");
  await page.mouse.move(0, 0);
  await tag("s-5").hover();
  await expect(page.getByTestId("row-linked-prs-tip").first()).toContainText("#142 · Open #145 · Draft #138 · Merged");
});

test("the thread card lists the linked PRs below the model, newest first, closed ones left out", async ({ page }) => {
  await linkFour();
  await link("s-1", 131);
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  const hoverName = async () => {
    await page.mouse.move(0, 0);
    await row(page, "s:s-1").getByTestId("thread-name").hover();
    await expect(tip).toHaveAttribute("data-thread-id", "s-1");
  };
  await hoverName();
  const prs = tip.getByTestId("tip-prs");
  await expect(prs).toBeVisible();
  // After the model; #147 and #131 are on no dashboard: unknown, the bare number.
  expect(await tip.locator("> div").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")).at(-1))).toBe("tip-prs");
  await expect(prs.getByTestId("tip-pr")).toHaveText(["#131", "#142feat(gui): virtualized sidebar tree with thread rows", "#147", /^#145/, /^#138/]);
  await expect(prs.getByTestId("tip-pr").first()).toHaveAttribute("data-state", "unknown");
  // The thread info card reads every detail: #131 is closed and leaves the tooltip, #147 gets its state and title.
  await row(page, "s:s-1").getByTestId("row-linked-prs").click();
  await expectCard(page);
  await hoverName();
  await expect(prs.getByTestId("tip-pr")).toHaveCount(4);
  await expect(prs.getByTestId("tip-pr").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")))).resolves.toEqual(["open", "open", "draft", "merged"]);
  await expect(prs.getByTestId("tip-prs-more")).toHaveCount(0);
  await page.mouse.move(0, 0);
  // A thread without links: no section.
  await row(page, "s:s-2").getByTestId("thread-name").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-2");
  await expect(tip.getByTestId("tip-prs")).toHaveCount(0);
});

/** SHOTS=<dir>: the sidebar tag's screenshots for docs/notes/sidebar-pr-tag.md's PR, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`sidebar tag screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await linkStates();
    await openApp(page);
    const tag = (thread: string) => row(page, `s:${thread}`).getByTestId("row-linked-prs");
    // Read #131 (closed) so it leaves s-5's count, then select s-1.
    await tag("s-5").click();
    await expect(tag("s-5")).toHaveText("3 PRs");
    await row(page, "s:s-1").click();
    await page.mouse.move(700, 450);
    const sidebar = page.getByTestId("sidebar");
    const box = await sidebar.boundingBox();
    if (!box) throw new Error("no sidebar");
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
    await page.screenshot({ path: `${shots ?? ""}/sidebar-pr-tag${suffix}.png`, clip });
    await tag("s-5").hover();
    await expect(page.getByTestId("row-linked-prs-tip").first()).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/sidebar-pr-tag-tip${suffix}.png`, clip: { ...clip, width: box.width + 300 } });
  });
}
