import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, mockUrl, openApp, openTooltip, resetMock, row } from "./fixtures";

/**
 * The thread info card (docs/notes/thread-info-card.md) over the mock's
 * POST /__mock/thread-info scenarios (World.addThreadInfo): one project (s-ti-1), a nine
 * project workspace (s-ti-ws), the same thread working, a child thread and a thread in a
 * folder without git.
 */

const card = (page: Page) => page.getByTestId("thread-info-card");
const toggle = (page: Page) => page.getByTestId("thread-info-toggle");

async function openWithCard(page: Page, scenario: string): Promise<string> {
  const { id } = (await mockPost(`thread-info?scenario=${scenario}`)) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  return id;
}

test.beforeEach(async () => {
  await resetMock();
});

test("one project: place, branch, pull requests, changes, shells, lineage, MCP, context and usage", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  // Off by default; the toggle (view.thread-info) shows it beside the conversation and composer.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  const id = await openWithCard(page, "single");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  const c = card(page);
  await expect(c.getByTestId("ti-workspace")).toHaveCount(0);
  await expect(c.getByTestId("ti-project")).toContainText("code-foundry");
  await expect(c.getByTestId("ti-project-meta")).toHaveText("Fresh copy");
  // One project: the menu offers Add project only (no Run in, nothing to save).
  await c.getByTestId("ti-project").click();
  await expect(page.getByTestId("ti-add-project")).toBeVisible();
  await expect(page.getByTestId("ti-runin-item")).toHaveCount(0);
  await expect(page.getByTestId("ti-save-workspace")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(c.getByTestId("ti-open-in")).toHaveText(/Open in Finder/);
  await expect(c.getByTestId("ti-action")).toContainText("Dev");
  await expect(c.getByTestId("ti-action-project")).toHaveCount(0);

  await expect(c.getByTestId("ti-branch")).toHaveAttribute("data-branch", "cf/sidebar-tree");
  await expect(c.getByTestId("ti-branch-ahead")).toHaveText("3");
  const prs = c.getByTestId("ti-pr");
  await expect(prs).toHaveCount(2);
  await expect(prs.nth(0)).toHaveAttribute("data-number", "78");
  await expect(prs.nth(0).getByTestId("ti-pr-line")).toHaveText(/#78\s*review requested/);
  await expect(prs.nth(1)).toHaveAttribute("data-state", "merged");
  await expect(c.getByTestId("ti-pr-project")).toHaveCount(0);
  await expect(c.getByTestId("ti-changes-meta")).toHaveText(/\+42\s*−9\s*· 4 files/);

  // The thread's own background shell, folded.
  await expect(c.getByTestId("ti-shells")).toContainText("1 shell");
  await c.getByTestId("ti-shells").click();
  await expect(c.getByTestId("ti-shell")).toHaveCount(1);

  // Lineage: running subagents and the child threads that work or wait, then the finished ones.
  await expect(c.getByTestId("ti-lineage-label")).toContainText(/Lineage · \d+ running/);
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k1"]')).toHaveAttribute("data-state", "working");
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k2"]')).toHaveAttribute("data-state", "attention");
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k3"]')).toHaveCount(0);
  // Subagent runs have no stop square; a live child's interrupts it, by click or by Enter, without opening it.
  await expect(c.locator('[data-testid="ti-lineage-stop"]')).toHaveCount(2);
  await expect(c.locator('[data-testid="ti-lineage-row"][data-kind="agent"]').first()).toBeVisible();
  const k1 = c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k1"]');
  await k1.hover();
  await c.locator('[data-testid="ti-lineage-stop"][data-id="s-ti-k1"]').click();
  await c.locator('[data-testid="ti-lineage-stop"][data-id="s-ti-k2"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.interrupt").map((i) => i.args.id)).toEqual(["s-ti-k1", "s-ti-k2"]);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await c.getByTestId("ti-previous").click();
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k3"]')).toHaveAttribute("data-state", "done");

  await expect(c.getByTestId("ti-mcp").locator("> span").nth(1)).toHaveText("2 connected");
  // Context: the row says only "Context"; its value column holds the warm cache's minutes, then the bar and share.
  await expect(c.getByTestId("ti-context").locator("> span").nth(0)).toHaveText("Context");
  await expect(c.getByTestId("ti-context-meta")).toHaveText(/^cache 41m\s*22%$/);
  await expect(c.getByTestId("ti-context-cache")).toHaveText("cache 41m");
  await expect(c.getByTestId("ti-context-pct")).toHaveText("22%");
  await expectTooltip(page, c.getByTestId("ti-context"), /^221K of 1M tokens used\s*Cache expires in 41 min\s*\$2\.21 to re-read it after that$/);

  // Usage: the row's value is the total cost in cents (no token count); the hover card splits it by model, one line each.
  const usage = c.getByTestId("ti-usage");
  await expect(usage.locator("> span").nth(0)).toHaveText("Usage");
  const cost = c.getByTestId("ti-usage-meta");
  await expect(cost).toHaveText(/^\$[\d,]+\.\d\d$/);
  await page.mouse.move(0, 0);
  await usage.hover();
  const tip = openTooltip(page);
  await expect(tip).toContainText("By model");
  await expect(tip.getByTestId("ti-usage-model-share")).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(tip.getByTestId("ti-usage-model-cost").nth(i)).toHaveText(/^\$[\d,]+\.\d\d$/);
    await expect(tip.getByTestId("ti-usage-model-share").nth(i)).toHaveText(/^\d+\.\d%$/);
    // The share sits on its cost's line, never wrapped under it.
    const [a, b] = await Promise.all([tip.getByTestId("ti-usage-model-cost").nth(i).boundingBox(), tip.getByTestId("ti-usage-model-share").nth(i).boundingBox()]);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? -100))).toBeLessThan(1);
  }
  await expect(tip).not.toContainText(/saved/i);
  await page.mouse.move(0, 0);

  // The fold: the token kinds, their total (the row's cost), what cache reads saved, the requests.
  await expect(c.getByTestId("ti-usage-detail")).toHaveCount(0);
  await usage.click();
  await expect(usage).toHaveAttribute("aria-expanded", "true");
  await expect(c.getByTestId("ti-usage-chevron")).toHaveAttribute("data-open", "");
  await expect(c.getByTestId("ti-usage-kind")).toHaveCount(4);
  await expect(c.getByTestId("ti-usage-kind")).toHaveText([/^Input.*\$/, /^Output.*\$/, /^Cache read.*\$/, /^Cache write.*\$/]);
  const total = c.getByTestId("ti-usage-total");
  await expect(total.locator("span")).toHaveText(["Total", /^[\d.]+[KMB]$/, (await cost.textContent()) ?? ""]);
  await expect(c.getByTestId("ti-usage-saved")).toHaveText(/^Saved by cache reads\$[\d,]+\.\d\d$/);
  await expect(c.getByTestId("ti-usage-saved").locator("span").last()).toHaveClass(/text-cf-success-text/);
  await expect(c.getByTestId("ti-usage-detail")).toContainText("Requests");
  // An open fold is not selected: with the pointer elsewhere it has a closed row's background, only its chevron says open.
  await page.mouse.move(0, 0);
  const bg = (l: typeof usage) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(async () => bg(usage)).toBe(await bg(c.getByTestId("ti-context")));

  // Changes opens the cwd's Changes tab (its files and commits); a pull request its PR tab.
  await c.getByTestId("ti-changes").click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(page.getByTestId("changes-surface").getByTestId("file-name")).toHaveText(["tree.ts", "Sidebar.tsx", "tree.test.ts", "sidebar-tree.md"]);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/^Changes$/);
  // At 1280px the side panel leaves the conversation too little room: the card steps aside until it closes.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await page.getByTestId("panel-toggle").click();
  await expect(card(page)).toBeVisible();
  await prs.nth(0).click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
  await page.getByTestId("panel-toggle").click();
  await expect(card(page)).toBeVisible();

  // The branch row copies the branch.
  await c.getByTestId("ti-branch").click();
  await expect(page.getByText("Branch copied")).toBeVisible();

  // The toggle is the window's: it stays on through a reload, and off hides the card.
  await page.reload();
  await row(page, `s:${id}`).click();
  await expect(card(page)).toBeVisible();
  await toggle(page).click();
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
});

test("nine projects in a workspace: Run in menu, other projects' pull requests, Changes fold, Fix sends a prompt", async ({ page }) => {
  const id = await openWithCard(page, "ws9");
  const c = card(page);
  await expect(c.getByTestId("ti-workspace")).toContainText("platform");
  await expect(c.getByTestId("ti-workspace-meta")).toHaveText("9 projects");
  await expect(c.getByTestId("ti-project")).toContainText("api");
  await expect(c.getByTestId("ti-project-chevron")).not.toHaveAttribute("data-open", "");

  await c.getByTestId("ti-project").click();
  const menu = page.getByTestId("ti-project-menu");
  await expect(menu).toBeVisible();
  await expect(c.getByTestId("ti-project-chevron")).toHaveAttribute("data-open", "");
  await expect(menu.getByTestId("ti-add-project")).not.toHaveAttribute("data-disabled", "");
  // A named workspace: nothing to save.
  await expect(menu.getByTestId("ti-save-workspace")).toHaveCount(0);
  await expect(menu.getByTestId("ti-runin-item")).toHaveCount(9);
  await expect(menu.locator('[data-testid="ti-runin-item"][data-current]')).toHaveAttribute("data-project", "repo-api");
  await expect(menu.locator('[data-testid="ti-runin-item"][data-project="repo-auth-lib"]')).toHaveText("auth-lib @ cf/auth-tokens-2");
  await expect(menu.locator('[data-testid="ti-runin-item"][data-project="repo-web"]')).toHaveText("web");
  // The menu spans the card less 6px a side (the row's own width), once its open animation ends.
  await expect
    .poll(async () => {
      const [m, k] = await Promise.all([menu.boundingBox(), c.boundingBox()]);
      return Math.round((k?.width ?? 0) - (m?.width ?? 0));
    })
    .toBe(14);
  await page.keyboard.press("Escape");

  // The action last run in this thread was web's: named with its project.
  await expect(c.getByTestId("ti-action")).toContainText("Typecheck");
  await expect(c.getByTestId("ti-action-project")).toHaveText("web");
  // It runs for the thread (its cwd is api) in its web checkout: the thread's bottom panel, no toast.
  await c.getByTestId("ti-action").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "action.run").map((i) => i.context?.activeThreadId)).toEqual([id]);
  await expect(page.getByTestId("bottom-panel").locator('[data-kind="action"]')).toHaveCount(1);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Typecheck" })).toHaveCount(0);

  // Pull requests over four projects: the cwd's first and unnamed, the others with their project; a stacked one names its base.
  const prs = c.getByTestId("ti-pr");
  await expect(prs).toHaveCount(7);
  await expect(prs.nth(0)).toHaveAttribute("data-number", "412");
  await expect(prs.nth(0).getByTestId("ti-pr-project")).toHaveCount(0);
  await expect(c.locator('[data-testid="ti-pr"][data-number="58"]').getByTestId("ti-pr-stacked")).toHaveText("#57");
  await expect(c.locator('[data-testid="ti-pr"][data-number="58"]').getByTestId("ti-pr-project")).toHaveText("auth-lib");
  await expect(c.locator('[data-testid="ti-pr"][data-number="19"]')).toHaveAttribute("data-state", "draft");

  await expect(c.getByTestId("ti-changes-meta")).toHaveText(/· 4 projects/);
  await c.getByTestId("ti-changes").click();
  await expect(c.getByTestId("ti-changes-project")).toHaveCount(4);
  // A project's row opens that checkout's Changes tab, named for the project.
  await c.locator('[data-testid="ti-changes-project"][data-project="repo-web"]').click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-project", "repo-web");
  await expect(page.getByTestId("changes-surface").getByTestId("file-name")).toHaveText(["auth.ts", "auth.test.ts"]);
  await page.getByTestId("panel-toggle").click();

  // Diverged: Fix sends the thread its prompt, the composer's draft untouched.
  await expect(c.getByTestId("ti-git")).toHaveAttribute("data-kind", "diverged");
  // A double click sends once (the button waits for the send).
  await c.getByTestId("ti-git-fix").dblclick();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.send").map((i) => [i.args.id, i.args.text])).toEqual([
    [id, expect.stringContaining("diverged from its upstream (3 ahead, 1 behind)") as unknown as string],
  ]);
});

test("a working thread: Push waits for the model, with the reason on hover", async ({ page }) => {
  await openWithCard(page, "busy");
  const push = card(page).getByTestId("ti-git");
  await expect(push).toHaveAttribute("data-kind", "push");
  await expect(push).toHaveAttribute("data-disabled", "");
  await expectTooltip(page, push, "A model is still working on this branch.");
  await push.click();
  await page.waitForTimeout(300);
  expect((await invocations()).filter((i) => i.name === "git.push")).toEqual([]);
});

test("a child thread: its parent row leads the lineage and goes to the parent", async ({ page }) => {
  await openWithCard(page, "child");
  const parent = card(page).getByTestId("ti-parent");
  await expect(parent).toContainText("Fix the stale PR badge");
  await expect(parent).toHaveAttribute("data-id", "s-ti-1");
  await expect(parent.getByTestId("ti-parent-meta")).toHaveText("Done");
  await parent.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ti-1");
});

const overlay = (page: Page) => page.getByTestId("thread-info-overlay");

test("a narrow pane: the card steps aside, the toggle floats it over the conversation, and the inline card returns with room", async ({ page }) => {
  await openWithCard(page, "single");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  // Not shown by itself: the toggle reads off, though the inline card's preference stays on.
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expectTooltip(page, toggle(page), "Toggle Thread Info");
  // The conversation keeps its width: the whole thread body.
  const body = await page.getByTestId("thread-pane-body").boundingBox();
  expect(body?.width ?? 0).toBeLessThan(800);

  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toHaveAttribute("aria-label", "Thread info");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).getByTestId("ti-project")).toContainText("code-foundry");
  // Over the conversation, which does not reflow: the body is as wide, the box 12px in from its top right.
  const after = await page.getByTestId("thread-pane-body").boundingBox();
  expect(after?.width).toBe(body?.width);
  const box = await overlay(page).boundingBox();
  expect(Math.round((after?.x ?? 0) + (after?.width ?? 0) - (box?.x ?? 0) - (box?.width ?? 0))).toBe(12);
  expect(Math.round((box?.y ?? 0) - (after?.y ?? 0))).toBe(12);
  expect(box?.width).toBe(308);

  // A menu inside works over it, and its Escape closes the menu only.
  await card(page).getByTestId("ti-project").click();
  await expect(page.getByTestId("ti-add-project")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ti-add-project")).toHaveCount(0);
  await expect(overlay(page)).toBeVisible();
  // A press inside keeps it (a fold), a second toggle hides it.
  await card(page).getByTestId("ti-usage").click();
  await expect(card(page).getByTestId("ti-usage-detail")).toBeVisible();
  await toggle(page).click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  // With room the inline card takes its place: hiding never cleared the preference.
  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("thread-info")).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  // Narrow again: it does not come back by itself.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(overlay(page)).toHaveCount(0);
});

test("the overlay: off at narrow turns the card on, Escape and a press outside hide it, the chord focuses it", async ({ page }) => {
  const { id } = (await mockPost("thread-info?scenario=single")) as { id: string };
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  // The chord shows it focused; Escape hides it and gives focus to the toggle.
  await page.getByTestId("thread-pane").focus();
  await page.keyboard.press("Meta+Shift+i");
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  // Hidden, not off: with room the inline card shows.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("thread-info")).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });

  // A click does not move focus; a press outside (the conversation) hides it.
  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).not.toBeFocused();
  await page.getByTestId("thread-pane-body").click({ position: { x: 40, y: 200 } });
  await expect(overlay(page)).toHaveCount(0);

  // Escape in the composer's prompt is the prompt's (focused without a press, which is outside).
  await toggle(page).click();
  await expect(overlay(page)).toBeVisible();
  await page.locator("[data-chord-yield] [contenteditable]").first().focus();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeVisible();

  // Another thread hides it.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await expect(overlay(page)).toHaveCount(0);
  await row(page, `s:${id}`).click();
  await expect(overlay(page)).toHaveCount(0);
});

test("a folder without git: no git group", async ({ page }) => {
  await openWithCard(page, "nogit");
  const c = card(page);
  await expect(c.getByTestId("ti-project")).toContainText("writing");
  await expect(c.getByTestId("ti-project-meta")).toHaveText("Project folder");
  await expect(c.getByTestId("ti-git-group")).toHaveCount(0);
  await expect(c.getByTestId("ti-context")).toBeVisible();
});

test("servers: a listening shell is a row that opens its port and stops the shell", async ({ page }) => {
  const id = await openWithCard(page, "servers");
  const c = card(page);
  const servers = c.getByTestId("ti-server");
  await expect(servers).toHaveCount(2);
  const web = servers.nth(0);
  const docs = servers.nth(1);
  await expect(web).toHaveAttribute("data-port", "5173");
  await expect(web).toContainText("localhost:5173");
  await expect(web.getByTestId("ti-server-line")).toHaveText(/^pnpm --dir web dev\s*· node\s*· 1m \d\ds$/);
  // Several ports: the first on the row, the rest in the hover card.
  await expect(web.getByTestId("ti-server-meta")).toHaveText("+1");
  await expectTooltip(page, web, /localhost:5173\s*localhost:24678/);
  await expect(docs.getByTestId("ti-server-line")).toContainText("· python");
  await expect(docs.getByTestId("ti-server-meta")).toHaveCount(0);
  // The shells that listen on nothing stay folded below.
  await expect(c.getByTestId("ti-shells")).toContainText("2 more shells");

  // A click opens the port in the browser.
  await docs.click();
  const opened = async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url);
  await expect.poll(opened).toEqual(["http://localhost:9399"]);

  // The stop square stops the shell, by click or by Enter, without opening the port; a
  // double click stops once.
  const stops = async () => (await invocations()).filter((i) => i.name === "thread.shell.stop").map((i) => `${i.args.id ?? ""} ${i.args.task ?? ""}`);
  await docs.hover();
  await c.locator('[data-testid="ti-server-stop"][data-task="bd9r3t6w1"]').dblclick();
  await expect.poll(stops).toEqual([`${id} bd9r3t6w1`]);
  await expect(servers).toHaveCount(1);
  await expect(page.getByTestId("thread-pane").getByText("Stopped background shell: python3 -m http.server 9399 --directory docs/_build")).toBeVisible();
  await c.locator('[data-testid="ti-server-stop"][data-task="bk4v8n2p7"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(stops).toEqual([`${id} bd9r3t6w1`, `${id} bk4v8n2p7`]);
  await expect(servers).toHaveCount(0);
  await expect(c.getByTestId("ti-shells")).toContainText("2 shells");
  expect(await opened()).toEqual(["http://localhost:9399"]);
});

test("an expired cache: the context row and its hover card say nothing of it", async ({ page }) => {
  const id = await openWithCard(page, "single");
  const c = card(page);
  await expect(c.getByTestId("ti-context-cache")).toHaveText("cache 41m");
  await mockPost(`thread/cache?id=${id}&ago=3700`);
  await expect(c.getByTestId("ti-context-cache")).toHaveCount(0);
  await expect(c.getByTestId("ti-context-meta")).toHaveText("22%");
  await expectTooltip(page, c.getByTestId("ti-context"), /^221K of 1M tokens used$/);
});

test("a thread under a cent: the row reads <$0.01, the kinds show no cost, nothing saved", async ({ page }) => {
  await mockPost("usage?thread=s-2&model=claude-haiku-5-5&requests=2&input=900&output=350&cacheRead=4000&cacheWrite5m=1200");
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await toggle(page).click();
  const c = card(page);
  await expect(c.getByTestId("ti-usage-meta")).toHaveText("<$0.01");
  await expectTooltip(page, c.getByTestId("ti-usage"), /^By model\s*Haiku 5\.5\s*<\$0\.01\s*100\.0%$/);
  await c.getByTestId("ti-usage").click();
  await expect(c.getByTestId("ti-usage-kind")).toHaveText(["Input900", "Output350", "Cache read4K", "Cache write1.2K"]);
  await expect(c.getByTestId("ti-usage-total")).toHaveText(/^Total6\.5K<\$0\.01$/);
  await expect(c.getByTestId("ti-usage-saved")).toHaveCount(0);
  await expect(c.getByTestId("ti-usage-detail")).toContainText(/Requests\s*2/);
});

/** A long conversation (the mock's html-scroll, s-r1) with the card shown over its right. */
async function openLongWithCard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=html-scroll");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-r1");
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("thread-html-frame")).toHaveAttribute("data-shown", "true");
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
}

async function wheelAt(page: Page, x: number, y: number, dy: number, times = 3): Promise<void> {
  await page.mouse.move(x, y);
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(50);
  }
}

async function box(l: ReturnType<Page["getByTestId"]>): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return b;
}

test("the card lays over the conversation: the list and composer keep clear, the scrollbar stays at the edge, a wheel under the card scrolls the list", async ({ page }) => {
  await openLongWithCard(page);
  const timeline = page.getByTestId("thread-timeline");
  const body = await box(page.getByTestId("thread-pane-body"));
  const c = await box(card(page));
  // The list's scroller spans the body, its thin scrollbar in the card's 12px gutter; the rows and the composer end left of the card.
  const t = await box(timeline);
  expect(Math.abs(t.x + t.width - (body.x + body.width))).toBeLessThan(1);
  expect(await timeline.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(12);
  expect(Math.abs(c.x + c.width + 12 - (body.x + body.width))).toBeLessThan(1);
  const log = await box(timeline.getByRole("log"));
  expect(log.x + log.width).toBeLessThanOrEqual(c.x);
  const composer = await box(page.getByTestId("composer-input"));
  expect(composer.x + composer.width).toBeLessThanOrEqual(c.x);
  // The card is shorter than the pane: a wheel under it reaches the list.
  expect(c.y + c.height + 100).toBeLessThan(body.y + body.height);
  const top = () => timeline.evaluate((el) => el.scrollTop);
  const before = await top();
  await wheelAt(page, c.x + c.width / 2, c.y + c.height + 60, -150);
  await expect.poll(top).toBeLessThan(before - 200);
  await expect(page.getByTestId("thread-jump-bottom")).toHaveAttribute("data-shown", "true");
});

test("a wheel over a card shorter than the pane scrolls the conversation, which stays up", async ({ page }) => {
  await openLongWithCard(page);
  const timeline = page.getByTestId("thread-timeline");
  const c = await box(card(page));
  const top = () => timeline.evaluate((el) => el.scrollTop);
  const before = await top();
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, -150);
  await expect.poll(top).toBeLessThan(before - 200);
  // The reader's own scroll: the list unpins (no snap back, after a resize hold's 400 ms too).
  await page.waitForTimeout(700);
  expect(await top()).toBeLessThan(before - 200);
  await expect(timeline).not.toHaveAttribute("data-at-bottom");
  const jump = page.getByTestId("thread-jump-bottom");
  await expect(jump).toHaveAttribute("data-shown", "true");
  expect(await page.getByTestId("thread-info").evaluate((el) => el.scrollTop)).toBe(0);
  // The chip centres on the conversation, left of the card.
  const j = await box(jump);
  expect(j.x + j.width).toBeLessThan(c.x);
  // Down over the card goes back to the bottom.
  await wheelAt(page, c.x + c.width / 2, c.y + c.height / 2, 400, 4);
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
});

test("a card taller than the pane scrolls itself under the wheel", async ({ page }) => {
  await openWithCard(page, "ws9");
  await page.setViewportSize({ width: 1300, height: 600 });
  const aside = page.getByTestId("thread-info");
  await expect.poll(() => aside.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const timeline = page.getByTestId("thread-timeline");
  const tlTop = await timeline.evaluate((el) => el.scrollTop);
  const a = await box(aside);
  await wheelAt(page, a.x + a.width / 2, a.y + a.height / 2, 100);
  await expect.poll(() => aside.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  expect(await timeline.evaluate((el) => el.scrollTop)).toBe(tlTop);
});

test("a page's Expand covers the conversation, not the card beside it", async ({ page }) => {
  await openLongWithCard(page);
  const c = await box(card(page));
  await page.getByTestId("thread-html-expand").last().click();
  const lightbox = page.getByTestId("thread-html-lightbox");
  await expect(lightbox).toBeVisible();
  const l = await box(lightbox);
  expect(l.x + l.width).toBeLessThanOrEqual(c.x);
  // The card stays usable while the page is open.
  await card(page).getByTestId("ti-context").hover();
  await expect(page.getByTestId("thread-html-lightbox")).toBeVisible();
  await page.getByTestId("thread-html-close").click();
  await expect(lightbox).toHaveCount(0);
});

test("the MCP row: connected count on the left, attention counts in the value column; the value and chevron open the menu, the rest opens the tab", async ({ page }) => {
  // s-r1 carries the MCP sketch's six servers (mock/mcp.ts): two connected, linear needs a login, playwright failed.
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await toggle(page).click();
  const c = card(page);
  const mcp = c.getByTestId("ti-mcp");
  await expect(mcp.locator("> span").nth(1)).toHaveText("2 connected");
  await expect(mcp.locator("> span").nth(1).locator("span")).toHaveClass(/text-cf-text-muted/);
  await expect(c.getByTestId("ti-mcp-meta")).toHaveText(/^1 needs login\s*1 failed$/);
  await expect(c.getByTestId("ti-mcp-needs-login")).toHaveClass(/text-cf-warning-text/);
  await expect(c.getByTestId("ti-mcp-failed")).toHaveClass(/text-cf-error-text/);
  // The value lines up with the other rows' values (its right edge, the same chevron column).
  const right = async (testId: string) => {
    const b = await c.getByTestId(testId).boundingBox();
    return (b?.x ?? 0) + (b?.width ?? 0);
  };
  expect(Math.abs((await right("ti-mcp-meta")) - (await right("ti-usage-meta")))).toBeLessThan(1);
  // One trigger zone: the value and the chevron, tinted together on hover.
  const zone = c.getByTestId("ti-mcp-menu-zone");
  await expect(zone.getByTestId("ti-mcp-meta")).toHaveCount(1);
  await expect(zone.getByTestId("ti-mcp-chevron")).toHaveCount(1);
  const bg = () => zone.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.mouse.move(0, 0);
  const resting = await bg();
  await c.getByTestId("ti-mcp-failed").hover();
  await expect.poll(bg).not.toBe(resting);

  // A press on the value opens the menu, not the tab.
  await c.getByTestId("ti-mcp-needs-login").click();
  const menu = page.getByTestId("ti-mcp-menu");
  await expect(menu).toBeVisible();
  await expect(c.getByTestId("ti-mcp-chevron")).toHaveAttribute("data-open", "");
  await expect(page.getByTestId("mcp-surface")).toHaveCount(0);
  // Reconnect is offered for the failed server only (a login cannot be done headlessly).
  await expect(menu.getByTestId("ti-mcp-reconnect")).toHaveCount(1);
  await expect(menu.getByTestId("ti-mcp-reconnect")).toHaveText("Reconnect playwright");
  await menu.getByTestId("ti-mcp-reconnect").click();
  await expect(menu).toHaveCount(0);
  await expect
    .poll(async () => ((await (await fetch(`${mockUrl}/__mock/thread/calls`)).json()) as string[]).includes("mcp-reconnect s-r1 playwright"))
    .toBe(true);
  await expect(c.getByTestId("ti-mcp-meta")).toHaveText("1 needs login");
  await expect(c.getByTestId("ti-mcp-failed")).toHaveCount(0);
  await expect(mcp.locator("> span").nth(1)).toHaveText("3 connected");

  // The chevron opens the menu too; ArrowDown from the focused row as well.
  await c.getByTestId("ti-mcp-chevron").click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await mcp.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // A press on the text opens the MCP tab.
  await mcp.locator("> span").nth(1).click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "mcp");
  await expect(menu).toHaveCount(0);
});
