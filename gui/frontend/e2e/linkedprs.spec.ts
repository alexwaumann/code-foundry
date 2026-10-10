import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The Linked PRs surface (docs/notes/linked-prs.md, GUI chunk): a thread's pull requests
 * from Claude's pr-link records, linked here through POST /__mock/link-pr. Set SHOTS=<dir>
 * to save the notes' screenshots (WebKit, 1400x900, dark and light).
 */

const CF = "alexwaumann/code-foundry";
const MIN = 60_000;

const panel = (page: Page) => page.getByTestId("side-panel");
const empty = (page: Page) => page.getByTestId("panel-empty");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const list = (page: Page) => page.getByTestId("linkedprs-list");
const numbers = (page: Page) => list(page).getByTestId("linkedpr-number");

async function link(session: string, number: number, agoMs = 0, slug = CF): Promise<void> {
  const res = (await mockPost(`link-pr?session=${session}&slug=${encodeURIComponent(slug)}&number=${String(number)}&ago=${String(agoMs)}`)) as { added: boolean };
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

async function expectLinkedTab(page: Page, session = "s-1"): Promise<void> {
  await expect(panel(page)).toHaveAttribute("data-panel-key", `session:${session}`);
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveText("Linked PRs");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "linkedprs");
}

const inPanel = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-region="panel"]') !== null);

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

test("hidden without links; a link brings the sidebar badge, the header button and the L entry", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("pane-actions")).toBeVisible();
  await expect(page.getByTestId("pane-linked-prs")).toHaveCount(0);
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+e");
  await expect(empty(page)).toBeVisible();
  await expect(empty(page).locator('[data-surface="pullrequest"]')).toBeVisible();
  await expect(empty(page).locator('[data-surface="linkedprs"]')).toHaveCount(0);
  // L does nothing without links.
  await page.keyboard.press("l");
  await expect(empty(page)).toBeVisible();

  await link("s-1", 142);
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveText("1 PR");
  await expect(page.getByTestId("pane-linked-prs")).toHaveAttribute("aria-label", "Show Linked PRs in Side Panel (1)");
  await expect(page.getByTestId("pane-linked-prs")).toContainText("1");
  const entry = empty(page).locator('[data-surface="linkedprs"]');
  await expect(entry).toHaveAttribute("data-availability", "enabled");
  await expect(entry).toContainText("Linked PRs");
  await expect(entry.locator("kbd")).toHaveText("L");

  await link("s-1", 147);
  await expect(row(page, "s:s-1").getByTestId("row-linked-prs")).toHaveText("2 PRs");
  await expect(page.getByTestId("pane-linked-prs")).toContainText("2");
  // Other threads have none.
  await expect(row(page, "s:s-2").getByTestId("row-linked-prs")).toHaveCount(0);
});

test("L and the header button open the list newest first; Enter opens a PR tab and cmd+w comes back", async ({ page }) => {
  await linkFour();
  await openApp(page);
  await row(page, "s:s-1").click();

  // L in the empty panel.
  await page.keyboard.press("Meta+Shift+e");
  await expect(empty(page).locator('[data-surface="linkedprs"]')).toHaveAttribute("data-availability", "enabled");
  await page.keyboard.press("l");
  await expectLinkedTab(page);
  await expect(page.getByTestId("linkedprs-thread")).toHaveText("Refactor sidebar tree");
  await expect(page.getByTestId("linkedprs-count")).toHaveText("4 linked PRs");
  await expect(numbers(page)).toHaveText(["#142", "#147", "#145", "#138"]);
  // Details from the cached PR detail: title, state, CI (open only), branch.
  await expect(list(page).getByTestId("linkedpr-title")).toHaveText([
    "feat(gui): virtualized sidebar tree with session rows",
    "feat(session): link pull requests from pr-link transcript records",
    "fix(terminal): resize race between attach and first output",
    "chore(gh): pace requests through one worker",
  ]);
  const states = list(page).getByTestId("linkedpr-state");
  await expect(states).toHaveText(["Open", "Open", "Draft", "Merged"]);
  const rows = list(page).getByTestId("linkedpr");
  await expect(rows.nth(0).locator("[data-checks]")).toHaveAttribute("data-checks", "success");
  await expect(rows.nth(1).locator("[data-checks]")).toHaveAttribute("data-checks", "failure");
  await expect(rows.nth(3).locator("[data-checks]")).toHaveCount(0);
  await expect(list(page).getByTestId("linkedpr-branch")).toHaveText(["feat/sidebar", "cf/linked-prs", "fix/resize", "gh-pacing"]);
  await expect(list(page).getByTestId("linkedpr-age").first()).toHaveText("linked 5m ago");
  // One repository: no repository names.
  await expect(list(page).getByTestId("linkedpr-repo")).toHaveCount(0);

  // Enter on the second row opens #147 as a tab of the same panel.
  await list(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveText(["Linked PRs", "#147"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-1");
  await expect(page.getByTestId("pr-surface")).toContainText("link pull requests from pr-link transcript records");
  // Focus stayed in the panel: cmd+w closes the PR tab, back to the list.
  await expect.poll(() => inPanel(page)).toBe(true);
  await page.keyboard.press("Meta+w");
  await expectLinkedTab(page);
  await expect(tabs(page)).toHaveText(["Linked PRs"]);
  await expect(numbers(page)).toHaveText(["#142", "#147", "#145", "#138"]);

  // A click opens one too.
  await rows.nth(3).click();
  await expect(tabs(page)).toHaveText(["Linked PRs", "#138"]);
  await page.keyboard.press("Meta+w");
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  // The thread header's button (view.panel.linked-prs).
  await page.getByTestId("pane-linked-prs").click();
  await expectLinkedTab(page);
  await expect.poll(() => inPanel(page)).toBe(true);
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  // The CLI's ShowView acts on the window's selection.
  expect(await emit({ showView: { name: "panel.linked-prs" } })).toBeGreaterThan(0);
  await expectLinkedTab(page);
});

test("the sidebar badge opens the surface for its thread and selects it", async ({ page }) => {
  await link("s-2", 12, 10 * MIN, "alexwaumann/ghostty-playground");
  await link("s-2", 147, 2 * MIN);
  await openApp(page);
  await row(page, "s:s-1").click();
  await row(page, "s:s-2").getByTestId("row-linked-prs").click();
  await expectLinkedTab(page, "s-2");
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("linkedprs-thread")).toHaveText("Port renderer");
  await expect(numbers(page)).toHaveText(["#147", "#12"]);
  // Two repositories: each row names its own.
  await expect(list(page).getByTestId("linkedpr-repo")).toHaveText(["· alexwaumann/code-foundry", "· alexwaumann/ghostty-playground"]);
});

test("hover actions: open on GitHub and copy the link", async ({ page }) => {
  await linkFour();
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.getByTestId("pane-linked-prs").click();
  await expectLinkedTab(page);
  const first = list(page).locator('[role="option"]').first();
  await first.hover();
  await first.getByTestId("linkedpr-copy").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([`https://github.com/${CF}/pull/142`]);
  await first.hover();
  await first.getByTestId("linkedpr-open-github").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url)).toEqual([`https://github.com/${CF}/pull/142`]);
  // Neither opened a tab.
  await expect(tabs(page)).toHaveText(["Linked PRs"]);
});

test("the palette lists it for any thread; without links it only says so", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Linked PRs");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.linked-prs"]').click();
  await expect(palette).toHaveCount(0);
  await expect(page.getByText("No linked PRs yet")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  // A plain terminal is no thread: not listed.
  await row(page, "t:t-logs").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Linked PRs");
  await expect(palette.locator('[data-command="view.panel.linked-prs"]')).toHaveCount(0);
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1400x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    const shot = (name: string) => page.screenshot({ path: `${String(shots)}/${name}${suffix}.png` });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await linkFour();
    await openApp(page);
    await row(page, "s:s-1").click();
    await expect(page.getByTestId("pane-linked-prs")).toBeVisible();

    await page.keyboard.press("Meta+Shift+e");
    await expect(empty(page).locator('[data-surface="linkedprs"]')).toBeVisible();
    await page.mouse.move(0, 0);
    await shot("linkedprs-empty-list");

    await page.keyboard.press("l");
    await expect(list(page).getByTestId("linkedpr-title")).toHaveCount(4);
    await list(page).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await shot("linkedprs-list");

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pr-surface")).toBeVisible();
    await expect(page.getByTestId("pr-loading")).toHaveCount(0);
    await shot("linkedprs-pr-tab");

    await page.keyboard.press("Meta+w");
    await page.keyboard.press("Meta+w");
    await expect(panel(page)).toHaveCount(0);
    await page.getByTestId("pane-linked-prs").hover();
    await shot("linkedprs-header-sidebar");
  });
}
