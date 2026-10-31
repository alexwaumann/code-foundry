import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { expectAttention, expectTooltip, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Thread lineage in the GUI (docs/notes/agents-3-lineage-gui.md) over the mock's
 * POST /__mock/lineage (World.addLineage): "Fix login redirect" (s-l-parent, working)
 * created "Add retry to login redirect" (s-l-child, finished, its log opening with the
 * daemon's "Created by" note) and six siblings of it, one archived; s-l-child created
 * "Write retry backoff tests" (s-l-grand), which recorded its creator as "Add retry to
 * login redirect (old)": the creator is resolved by its id and shown under its current
 * name (docs/notes/lineage-by-id.md), the recorded one only once it is removed. Set
 * SHOTS=<dir> to save screenshots (WebKit, dark and light).
 */

const P = "s-l-parent";
const C = "s-l-child";
const header = (page: Page) => page.getByTestId("thread-header");
/** The crumb's parent segment (docs/notes/thread-header-crumb.md). */
const parent = (page: Page) => header(page).getByTestId("thread-crumb-parent");
const card = (page: Page) => page.getByTestId("thread-info-card");
/** A thread's row in the thread info card's lineage group (finished ones under Previous). */
const lineageRow = (page: Page, id: string) => card(page).locator(`[data-testid="ti-lineage-row"][data-id="${id}"]`);

async function open(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

/** Shows the thread info card (its lineage rows) and unfolds its finished rows. */
async function openCard(page: Page): Promise<void> {
  if ((await page.getByTestId("thread-info-toggle").getAttribute("aria-pressed")) !== "true") await page.getByTestId("thread-info-toggle").click();
  await expect(card(page)).toBeVisible();
  const previous = card(page).getByTestId("ti-previous");
  if ((await previous.count()) > 0 && (await previous.getAttribute("aria-expanded")) !== "true") await previous.click();
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

// The lineage itself, with every created thread in the sidebar (threads.show_created_threads
// on). Hidden children, the default, are the describe block at the end.
test.describe("lineage", () => {
  test.beforeEach(async () => {
    await mockPost("settings/external?threads.show_created_threads=true");
  });

  test("sidebar: a muted ↳ before the name of every thread a thread created, in the footers too; the tooltip says who", async ({ page }) => {
    await openApp(page);
    // The child (finished, main list), a sibling working (Working footer), the user's own threads.
    await expect(row(page, `s:${C}`).getByTestId("row-created-by")).toBeVisible();
    await expect(row(page, "s:s-l-e2e").getByTestId("row-created-by")).toBeVisible();
    await expect(row(page, `s:${P}`).getByTestId("row-created-by")).toHaveCount(0);
    await expect(row(page, "s:s-1").getByTestId("row-created-by")).toHaveCount(0);
    // Before the name, the other lines unchanged.
    const name = await row(page, `s:${C}`).getByTestId("thread-name").boundingBox();
    const glyph = await row(page, `s:${C}`).getByTestId("row-created-by").boundingBox();
    expect((glyph?.x ?? 0) + (glyph?.width ?? 0)).toBeLessThanOrEqual((name?.x ?? 0) + 1);
    await expect(row(page, `s:${C}`).getByTestId("row-status")).toHaveText("Done");
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

  test("header: the crumb names the creator, which opens; the timeline opens with the Created by note", async ({ page }) => {
    await openApp(page);
    await open(page, C);
    await expect(parent(page)).toHaveText("Fix login redirect");
    // Place, creator, title in that order.
    const place = await header(page).getByTestId("thread-crumb-place").boundingBox();
    const p = await parent(page).boundingBox();
    const title = await header(page).getByTestId("thread-title").boundingBox();
    expect((place?.x ?? 0) < (p?.x ?? 0) && (p?.x ?? 0) < (title?.x ?? 0)).toBe(true);

    // The note: one muted line at the top, the creator a link, the brief, the age.
    const note = page.getByTestId("thread-created-by-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Created by");
    await expect(note.getByTestId("thread-created-by-note-link")).toHaveText("Fix login redirect");
    await expect(note.getByTestId("thread-created-by-note-brief")).toHaveText("brief: Add retry to the login redirect, keep the PR small");
    await expect(note.getByTestId("thread-created-by-note-age")).toHaveText("18 min ago");
    await expect(page.getByTestId("thread-note")).toHaveCount(0);

    // The crumb's creator opens it; the user's own thread has no parent segment.
    await parent(page).click();
    await expect(header(page).getByTestId("thread-title")).toHaveText("Fix login redirect");
    await expect(parent(page)).toHaveCount(0);
    // So does the note's link.
    await open(page, C);
    await note.getByTestId("thread-created-by-note-link").click();
    await expect(header(page).getByTestId("thread-title")).toHaveText("Fix login redirect");
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

  test("header: a removed creator leaves an inert crumb segment saying so, with the recorded name", async ({ page }) => {
    await openApp(page);
    await open(page, "s-l-grand");
    await expect(parent(page)).toHaveText("Add retry to login redirect");
    await expect(parent(page)).not.toHaveAttribute("data-removed", "true");
    await removeThread(C);
    // Gone from the list: the name the thread recorded when it was created.
    await expect(parent(page)).toHaveAttribute("data-removed", "true");
    await expect(parent(page)).toHaveText("Add retry to login redirect (old)");
    await expectTooltip(page, parent(page), "Thread removed");
    await parent(page).click();
    await expect(header(page).getByTestId("thread-title")).toHaveText("Write retry backoff tests");
    await expect(page.getByTestId("thread-created-by-note-link")).toHaveCount(0);
    await expect(page.getByTestId("thread-created-by-note-name")).toHaveText("Add retry to login redirect (old)");
  });
});

/**
 * Hidden child threads (docs/notes/hidden-children-2-gui.md): with
 * threads.show_created_threads off (the default) every thread P created is out of the
 * sidebar except s-l-logs, shown by its override; they stay in P's thread info card.
 */
test.describe("hidden children", () => {
  const LOGS = "s-l-logs";
  const HIDDEN = [C, "s-l-e2e", "s-l-cookie", "s-l-allow", "s-l-spike", "s-l-metrics", "s-l-grand"];
  const sidebarKeys = (page: Page) => page.getByTestId("thread-list").locator('[data-row-key^="s:"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));

  async function invoke(name: string, args: Record<string, string>, context: Record<string, string> | null = null, confirmed = true): Promise<{ message?: string }> {
    const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
      body: JSON.stringify({ name, args, ...(context ? { context } : {}), confirmed }),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    return (await res.json()) as { message?: string };
  }

  async function archivedIds(): Promise<string[]> {
    const res = await fetch(`${mockUrl}/codefoundry.v1.ThreadService/List`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
      body: "{}",
    });
    const { threads } = (await res.json()) as { threads: { id: string; archivedAt?: string }[] };
    return threads.filter((t) => t.archivedAt).map((t) => t.id);
  }

  test("are in no sidebar list, footers included, nor the attention count; the setting shows them live, from the settings page too", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("archived-header").click();
    await expect(row(page, `s:${P}`)).toBeVisible();
    await expect(row(page, `s:${LOGS}`)).toBeVisible();
    await expect(row(page, `s:${LOGS}`).getByTestId("row-created-by")).toBeVisible();
    for (const id of HIDDEN) await expect(row(page, `s:${id}`)).toHaveCount(0);
    // C's finished turn, s-l-cookie's permission prompt and s-l-allow's API error are not counted.
    const before = Number(/\((\d+)\)/.exec(await page.title())?.[1] ?? "0");

    // Settings › General › Threads: the toggle, off; on, every created thread joins the list.
    await page.keyboard.press("Meta+Comma");
    const toggle = page.locator('[data-setting="threads.show_created_threads"]');
    await expect(toggle).toContainText("Show threads created by other threads");
    await expect(toggle.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await toggle.getByRole("switch").click();
    await expect(toggle.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    for (const id of HIDDEN) await expect(row(page, `s:${id}`)).toHaveCount(1);
    await expect(row(page, `s:s-l-e2e`)).toHaveAttribute("data-section", "working");
    await expect(row(page, `s:s-l-spike`)).toHaveAttribute("data-section", "archived");
    await expectAttention(page, before + 3);

    // Off again (a hand edit of the file, as the CLI's settings set does).
    await mockPost("settings/external?threads.show_created_threads=false");
    for (const id of HIDDEN) await expect(row(page, `s:${id}`)).toHaveCount(0);
    await expectAttention(page, before);
  });

  test("cmd+shift+a and cmd+1..9 walk the shown rows only", async ({ page }) => {
    await openApp(page);
    await expect(row(page, `s:${LOGS}`)).toBeVisible();
    const selectedId = () => page.getByTestId("thread-pane").getAttribute("data-thread-id");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Meta+Shift+a");
      await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
    }
    const keys = await sidebarKeys(page);
    // Main list, then Working (P among them); Snoozed and Archived collapsed. No hidden child.
    expect(keys.filter((k) => HIDDEN.includes(String(k).slice(2)))).toEqual([]);
    for (const n of [1, 5, keys.length]) {
      await page.keyboard.press(`Meta+${String(n)}`);
      await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", String(keys[n - 1]).slice(2));
    }
    // With the setting on, the hidden ones waiting join the walk.
    await mockPost("settings/external?threads.show_created_threads=true");
    await expect(row(page, `s:${C}`)).toBeVisible();
    const visited = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const prev = await selectedId();
      await page.keyboard.press("Meta+Shift+a");
      await expect.poll(selectedId).not.toBe(prev);
      visited.add(String(await selectedId()));
    }
    expect([...visited].sort()).toEqual(["s-2", C, "s-l-allow", "s-l-cookie"].sort());
  });

  test("row menu: Hide from sidebar on a shown child takes its row out; none on the user's own thread", async ({ page }) => {
    await openApp(page);
    await row(page, `s:${LOGS}`).click({ button: "right" });
    const menu = page.getByTestId("row-menu");
    await expect(menu.getByTestId("menu-sidebar-hide")).toHaveText("Hide from sidebar");
    await menu.getByTestId("menu-sidebar-hide").click();
    await expect(row(page, `s:${LOGS}`)).toHaveCount(0);
    expect((await invocations()).filter((i) => i.name === "thread.sidebar").map((i) => [i.context?.activeThreadId, i.args.shown])).toEqual([[LOGS, "false"]]);
    await row(page, `s:${P}`).click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("menu-sidebar-hide")).toHaveCount(0);
  });

  test("a hidden child open (from the card): its creator's row is highlighted and arrows move from it; the title menu shows and hides it", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    await openCard(page);
    await lineageRow(page, C).click();
    await expect(header(page).getByTestId("thread-title")).toHaveText("Add retry to login redirect");
    await expect(row(page, `s:${C}`)).toHaveCount(0);
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("thread-list").locator('[aria-selected="true"]')).toHaveCount(1);

    // A hidden grandchild (from C's own card): still its nearest shown ancestor, P.
    await openCard(page);
    await lineageRow(page, "s-l-grand").click();
    await expect(header(page).getByTestId("thread-title")).toHaveText("Write retry backoff tests");
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");

    // Arrow keys start from the highlighted row.
    const keys = await sidebarKeys(page);
    const next = keys[keys.indexOf(`s:${P}`) + 1];
    const list = page.getByTestId("thread-list");
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toHaveAttribute("aria-activedescendant", `row-${String(next)}`);

    // The title menu: Show in sidebar, then Hide from sidebar.
    const title = header(page).getByTestId("thread-title");
    await title.click();
    const menu = page.getByTestId("thread-title-menu");
    await expect(menu.getByTestId("menu-sidebar-show")).toHaveText("Show in sidebar");
    await menu.getByTestId("menu-sidebar-show").click();
    await expect(menu).toHaveCount(0);
    await expect(row(page, "s:s-l-grand")).toHaveAttribute("aria-selected", "true");
    await expect(row(page, `s:${P}`)).not.toHaveAttribute("aria-selected", "true");
    await title.click();
    await expect(menu.getByTestId("menu-sidebar-hide")).toHaveText("Hide from sidebar");
    await menu.getByTestId("menu-sidebar-hide").click();
    await expect(row(page, "s:s-l-grand")).toHaveCount(0);
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");
    expect((await invocations()).filter((i) => i.name === "thread.sidebar").map((i) => [i.context?.activeThreadId, i.args.shown])).toEqual([
      ["s-l-grand", "true"],
      ["s-l-grand", "false"],
    ]);
    // The user's own thread has neither.
    await open(page, P);
    await title.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("menu-sidebar-show")).toHaveCount(0);
    await expect(menu.getByTestId("menu-sidebar-hide")).toHaveCount(0);
  });

  test("a thread an agent creates hidden does not take the view; one created with --sidebar does", async ({ page }) => {
    await openApp(page);
    await open(page, "s-3");
    const title = header(page).getByTestId("thread-title");
    await expect(title).not.toHaveText("");
    const before = await title.textContent();
    const cli = { activeProjectId: "repo-cf" };
    const hidden = await invoke("thread.new", { project: "repo-cf", "created-by": P, name: "Quiet worker", prompt: "work quietly" }, cli);
    expect(hidden.message).toMatch(/^created thread s-new-\d+ in /);
    const id = /s-new-\d+/.exec(hidden.message ?? "")?.[0] ?? "";
    // Give the intent time to land, then check nothing moved.
    await page.waitForTimeout(500);
    await expect(title).toHaveText(String(before));
    await expect(row(page, `s:${id}`)).toHaveCount(0);

    const shown = await invoke("thread.new", { project: "repo-cf", "created-by": P, name: "Handed over", prompt: "work here", sidebar: "true" }, cli);
    expect(shown.message).toMatch(/; shown in the sidebar$/);
    await expect(title).toHaveText("Handed over");
    await expect(row(page, `s:${/s-new-\d+/.exec(shown.message ?? "")?.[0] ?? ""}`)).toHaveAttribute("aria-selected", "true");
  });

  test("archiving the creator asks (its working hidden children named), then archives the hidden ones with it; the shown one stays", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    await header(page).getByTestId("thread-title").click();
    await page.getByTestId("thread-title-menu").getByTestId("menu-archive").click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toContainText(
      "Archive thread Fix login redirect? Claude is still working; archiving ends the turn. 2 hidden child threads are still working; archiving ends their turns and archives them too. To keep one, ask Fix login redirect to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.",
    );
    await page.getByTestId("confirm-ok").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await archivedIds()).sort()).toEqual([P, ...HIDDEN, "s-7"].sort());
    // The shown child stays in the sidebar.
    await expect(row(page, `s:${LOGS}`)).not.toHaveAttribute("data-section", "archived");
    // Under Archived: P only (its hidden children stay hidden there too).
    await page.getByTestId("archived-header").click();
    await expect(row(page, `s:${P}`)).toHaveAttribute("data-section", "archived");
    for (const id of HIDDEN) await expect(row(page, `s:${id}`)).toHaveCount(0);
  });
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockPost("settings/external?threads.show_created_threads=true");
    await openApp(page);
    await open(page, C);
    await openCard(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/lineage-mock-${scheme}.png` });
  });
}
