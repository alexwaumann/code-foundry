import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { emit, expectTooltip, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Thread lineage in the GUI (docs/notes/agents-3-lineage-gui.md) over the mock's
 * POST /__mock/lineage (World.addLineage): "Fix login redirect" (s-l-parent, working)
 * created "Add retry to login redirect" (s-l-child, finished, its log opening with the
 * daemon's "Created by" note) and six siblings of it, one archived; s-l-child created
 * "Write retry backoff tests" (s-l-grand). Set SHOTS=<dir> to save screenshots (WebKit,
 * dark and light).
 */

const P = "s-l-parent";
const C = "s-l-child";
const surface = (page: Page) => page.getByTestId("threads-surface");
const section = (page: Page, id: string) => surface(page).getByTestId(`threads-section-${id}`);
const sectionIds = (page: Page, id: string) => section(page, id).getByTestId("lineage-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-thread")));
const lineageRow = (page: Page, id: string) => surface(page).locator(`[data-testid="lineage-row"][data-thread="${id}"]`);
const header = (page: Page) => page.getByTestId("thread-header");
const chip = (page: Page) => header(page).getByTestId("thread-created-by");

async function open(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

async function expectThreadsTab(page: Page, id: string): Promise<void> {
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel-key", `thread:${id}`);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "threads");
  await expect(surface(page)).toHaveAttribute("data-thread", id);
}

async function removeThread(id: string): Promise<void> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "thread.remove", context: { activeThreadId: id }, confirmed: true }),
  });
  expect(res.ok).toBe(true);
}

test.beforeEach(async () => {
  await resetMock();
  await mockPost("lineage");
});

test("sidebar: a muted ↳ before the name of every thread a thread created, in the footers too; the tooltip says who", async ({ page }) => {
  await openApp(page);
  // The child (finished, main list), a sibling working (Working footer), the user's own threads.
  await expect(row(page, `s:${C}`).getByTestId("row-created-by")).toBeVisible();
  await expect(row(page, "s:s-l-e2e").getByTestId("row-created-by")).toBeVisible();
  await expect(row(page, `s:${P}`).getByTestId("row-created-by")).toHaveCount(0);
  await expect(row(page, "s:s-1").getByTestId("row-created-by")).toHaveCount(0);
  // Before the name, line 2 unchanged.
  const name = await row(page, `s:${C}`).getByTestId("thread-name").boundingBox();
  const glyph = await row(page, `s:${C}`).getByTestId("row-created-by").boundingBox();
  expect((glyph?.x ?? 0) + (glyph?.width ?? 0)).toBeLessThanOrEqual((name?.x ?? 0) + 1);
  await expect(row(page, `s:${C}`).getByTestId("row-place")).toHaveText(/^Finished /);
  // The archived sibling in the Archived footer.
  await page.getByTestId("archived-header").click();
  await expect(row(page, "s:s-l-spike").getByTestId("row-created-by")).toBeVisible();

  // The row tooltip: "Created by <creator>" under the status.
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  await row(page, "s:s-l-cookie").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-l-cookie");
  await expect(tip.getByTestId("tip-created-by")).toHaveText("Created by Fix login redirect");
  expect(await tip.locator("> div").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(["tip-name", "tip-status", "tip-created-by", "tip-project", "tip-branch", "tip-model"]);
  await row(page, "s:s-1").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-1");
  await expect(tip.getByTestId("tip-created-by")).toHaveCount(0);
});

test("header: the from chip after the name opens the Threads tab; the timeline opens with the Created by note", async ({ page }) => {
  await openApp(page);
  await open(page, C);
  await expect(chip(page)).toHaveText("from Fix login redirect");
  // Name, chip, location in that order.
  const title = await header(page).getByTestId("thread-title").boundingBox();
  const c = await chip(page).boundingBox();
  const loc = await header(page).getByTestId("thread-location").boundingBox();
  expect((title?.x ?? 0) < (c?.x ?? 0) && (c?.x ?? 0) < (loc?.x ?? 0)).toBe(true);

  // The note: one muted line at the top, the creator a link, the brief, the age.
  const note = page.getByTestId("thread-created-by-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Created by");
  await expect(note.getByTestId("thread-created-by-note-link")).toHaveText("Fix login redirect");
  await expect(note.getByTestId("thread-created-by-note-brief")).toHaveText("brief: Add retry to the login redirect, keep the PR small");
  await expect(note.getByTestId("thread-created-by-note-age")).toHaveText("18 min ago");
  await expect(page.getByTestId("thread-note")).toHaveCount(0);

  await chip(page).click();
  await expectThreadsTab(page, C);

  // The note's link opens the creator.
  await note.getByTestId("thread-created-by-note-link").click();
  await expect(header(page).getByTestId("thread-title")).toHaveText("Fix login redirect");
  await expect(chip(page)).toHaveCount(0);
});

test("timeline: a wake message is a collapsed Woken by note that expands to its payload", async ({ page }) => {
  await openApp(page);
  await open(page, P);
  const note = page.getByTestId("thread-wake-note");
  await expect(note).toBeVisible();
  await expect(note.getByTestId("thread-wake-note-link")).toHaveText("Add retry to login redirect");
  await expect(note.getByTestId("thread-wake-note-detail")).toHaveText(": idle, finished");
  await expect(note.getByTestId("thread-wake-note-summary")).toHaveText("Retry added around exchangeToken, 3 attempts; PR opened");
  await expect(note.locator("svg.t-emerald")).toHaveCount(1);
  // Not a bubble: the wake text with its fenced block is not shown.
  await expect(page.getByTestId("thread-pane")).not.toContainText("[code-foundry wake]");
  await expect(note.getByTestId("thread-wake-note-body")).toHaveCount(0);
  await note.getByTestId("thread-wake-note-line").click();
  await expect(note.getByTestId("thread-wake-note-body").locator("pre")).toContainText('"subscription_id": "sub-l-1"');
  await expect(note.getByTestId("thread-wake-note-body").locator("pre")).toContainText('"pr": 412');
  await note.getByTestId("thread-wake-note-line").click();
  await expect(note.getByTestId("thread-wake-note-body")).toHaveCount(0);
  // The name opens the thread that woke it.
  await note.getByTestId("thread-wake-note-link").click();
  await expect(header(page).getByTestId("thread-title")).toHaveText("Add retry to login redirect");
});

test("header: a removed creator leaves an inert chip saying so; an archived one still opens", async ({ page }) => {
  await openApp(page);
  await open(page, "s-l-grand");
  await expect(chip(page)).toHaveText("from Add retry to login redirect");
  await expect(chip(page)).not.toHaveAttribute("data-removed", "true");
  await removeThread(C);
  await expect(chip(page)).toHaveAttribute("data-removed", "true");
  await expect(chip(page)).toHaveText("from Add retry to login redirect");
  await expect(chip(page)).toHaveCSS("cursor", "default");
  await expectTooltip(page, chip(page), "Thread removed");
  await chip(page).click();
  await expect(page.getByTestId("panel-body")).toHaveCount(0);
  await expect(page.getByTestId("thread-created-by-note-link")).toHaveCount(0);
  await expect(page.getByTestId("thread-created-by-note-name")).toHaveText("Add retry to login redirect");
});

test("Threads tab on an agent's thread: creator, this thread, five siblings then +1 more, its child; rows open threads", async ({ page }) => {
  await openApp(page);
  await open(page, C);
  expect(await emit({ showView: { name: "panel.threads" } })).toBeGreaterThan(0);
  await expectThreadsTab(page, C);

  await expect(surface(page).getByTestId("threads-count")).toHaveText("8 related");
  await expect(surface(page).getByTestId("threads-subline")).toHaveText("Created by Fix login redirect · 6 siblings · 1 child");
  expect(await sectionIds(page, "creator")).toEqual([P]);
  expect(await sectionIds(page, "this")).toEqual([C]);
  expect(await sectionIds(page, "siblings")).toEqual(["s-l-e2e", "s-l-cookie", "s-l-allow", "s-l-spike", "s-l-logs"]);
  expect(await sectionIds(page, "children")).toEqual(["s-l-grand"]);
  await expect(section(page, "siblings").getByTestId("threads-section-siblings-count")).toHaveText("6");
  await expect(surface(page).locator("h3")).toHaveText(["Created by", "This thread", "Siblings6", "Children1"]);

  // Status words in the sidebar's tones, place and brief (viewing the child saw its finished turn: idle).
  await expect(surface(page).getByTestId("lineage-row").getByTestId("lineage-status")).toHaveText(["Working", "Idle", "Working", "Needs input", "Error", "Archived", "Idle", "Idle"]);
  await expect(lineageRow(page, C).getByTestId("lineage-place")).toHaveText("code-foundry @ fix/resize");
  await expect(lineageRow(page, C).getByTestId("lineage-brief")).toHaveText("Add retry to the login redirect, keep the PR small");
  await expect(lineageRow(page, P).getByTestId("lineage-brief")).toHaveCount(0);
  await expect(lineageRow(page, C)).toHaveAttribute("data-me", "true");
  await expect(lineageRow(page, C)).toContainText("this thread");
  await expect(lineageRow(page, "s-l-spike")).toHaveAttribute("data-status", "archived");

  await surface(page).getByTestId("lineage-more").click();
  expect(await sectionIds(page, "siblings")).toEqual(["s-l-e2e", "s-l-cookie", "s-l-allow", "s-l-spike", "s-l-logs", "s-l-metrics"]);

  // A row opens its thread like a sidebar click.
  await lineageRow(page, "s-l-cookie").click();
  await expect(header(page).getByTestId("thread-title")).toHaveText("Audit session cookie flags");
  await expect(row(page, "s:s-l-cookie")).toHaveAttribute("aria-selected", "true");
});

test("Threads tab on the creator and on a thread with no lineage; H and the palette open it", async ({ page }) => {
  await openApp(page);
  await open(page, P);
  // H in the panel's surface list.
  await page.getByTestId("thread-pane").getByRole("button", { name: "Toggle Side Panel" }).click();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="threads"]')).toBeVisible();
  await page.keyboard.press("h");
  await expectThreadsTab(page, P);
  await expect(surface(page).getByTestId("threads-count")).toHaveText("7 related");
  await expect(surface(page).getByTestId("threads-subline")).toHaveText("Created by you · 7 threads created from here, in 2 projects");
  await expect(section(page, "creator")).toHaveCount(0);
  await expect(section(page, "siblings")).toHaveCount(0);
  expect(await sectionIds(page, "children")).toEqual([C, "s-l-e2e", "s-l-cookie", "s-l-allow", "s-l-spike", "s-l-logs", "s-l-metrics"]);

  await open(page, "s-3");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Related Threads");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.threads"]').click();
  await expectThreadsTab(page, "s-3");
  await expect(surface(page).getByTestId("threads-empty")).toContainText("Created by you. No threads created from here.");
  await expect(surface(page).getByTestId("threads-count")).toHaveCount(0);
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await open(page, C);
    expect(await emit({ showView: { name: "panel.threads" } })).toBeGreaterThan(0);
    await expectThreadsTab(page, C);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/lineage-mock-${scheme}.png` });
  });
}
