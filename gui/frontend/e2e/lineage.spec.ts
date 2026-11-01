import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { expectAttention, expectTooltip, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Thread lineage in the GUI (docs/notes/agents-3-lineage-gui.md) over the mock's
 * POST /__mock/lineage (World.addLineage): "Fix login redirect" (s-l-parent, working)
 * created "Add retry to login redirect" (s-l-child, finished, its log opening with the
 * daemon's "Created by" note) and six siblings of it, one archived; s-l-child created
 * "Write retry backoff tests" (s-l-grand), which recorded its creator as "Add retry to
 * login redirect (old)": the creator is resolved by its id and shown under its current
 * name (docs/notes/lineage-by-id.md), the recorded one only once it is removed.
 *
 * A thread another thread created is out of the sidebar while its creator exists, with no
 * setting or override to change that (docs/notes/no-sidebar-override-1-gui.md); it is
 * reached through its creator's thread info card. POST /__mock/thread/forget removes a
 * creator alone, leaving its children orphaned: they join the sidebar. Set SHOTS=<dir> to
 * save screenshots (WebKit, dark and light).
 */

const P = "s-l-parent";
const C = "s-l-child";
/** Every thread P created (s-l-spike archived), and C's own child. */
const CHILDREN = [C, "s-l-e2e", "s-l-cookie", "s-l-allow", "s-l-spike", "s-l-logs", "s-l-metrics"];
const ALL = [...CHILDREN, "s-l-grand"];
const header = (page: Page) => page.getByTestId("thread-header");
/** The crumb's parent segment (docs/notes/thread-header-crumb.md). */
const parent = (page: Page) => header(page).getByTestId("thread-crumb-parent");
const card = (page: Page) => page.getByTestId("thread-info-card");
/** A thread's row in the thread info card's lineage group (finished ones under Previous). */
const lineageRow = (page: Page, id: string) => card(page).locator(`[data-testid="ti-lineage-row"][data-id="${id}"]`);
const sidebarKeys = (page: Page) => page.getByTestId("thread-list").locator('[data-row-key^="s:"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));

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

/** Opens a child thread the way the user reaches it: from its creator's (open) thread info card. */
async function openFromCard(page: Page, id: string, title: string): Promise<void> {
  await openCard(page);
  await lineageRow(page, id).click();
  await expect(header(page).getByTestId("thread-title")).toHaveText(title);
}

test.beforeEach(async () => {
  await resetMock();
  await mockPost("lineage");
});

test.describe("lineage", () => {
  test("sidebar: children are out while their creator exists; once it is gone they join with a muted ↳, the tooltip naming the removed creator", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("archived-header").click();
    await expect(row(page, `s:${P}`)).toBeVisible();
    for (const id of ALL) await expect(row(page, `s:${id}`)).toHaveCount(0);

    // The creator goes alone: its children are orphans, in the sidebar; C's child stays C's.
    await mockPost(`thread/forget?id=${P}`);
    await expect(row(page, `s:${P}`)).toHaveCount(0);
    for (const id of CHILDREN) await expect(row(page, `s:${id}`)).toHaveCount(1);
    await expect(row(page, "s:s-l-grand")).toHaveCount(0);
    await expect(row(page, "s:s-l-e2e")).toHaveAttribute("data-section", "working");
    await expect(row(page, "s:s-l-spike")).toHaveAttribute("data-section", "archived");
    // The ↳ glyph before the name, in the footers too; none on the user's own threads.
    await expect(row(page, `s:${C}`).getByTestId("row-created-by")).toBeVisible();
    await expect(row(page, "s:s-l-e2e").getByTestId("row-created-by")).toBeVisible();
    await expect(row(page, "s:s-l-spike").getByTestId("row-created-by")).toBeVisible();
    await expect(row(page, "s:s-1").getByTestId("row-created-by")).toHaveCount(0);
    const name = await row(page, `s:${C}`).getByTestId("thread-name").boundingBox();
    const glyph = await row(page, `s:${C}`).getByTestId("row-created-by").boundingBox();
    expect((glyph?.x ?? 0) + (glyph?.width ?? 0)).toBeLessThanOrEqual((name?.x ?? 0) + 1);
    await expect(row(page, `s:${C}`).getByTestId("row-status")).toHaveText("Done");

    // The row tooltip: "Created by <recorded name> (removed)" under the status.
    const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
    await row(page, "s:s-l-cookie").hover();
    await expect(tip).toHaveAttribute("data-thread-id", "s-l-cookie");
    await expect(tip.getByTestId("tip-created-by")).toHaveText("Created by Fix login redirect (removed)");
    await expect(tip.getByTestId("tip-created-by")).toHaveAttribute("data-removed", "true");
    expect(await tip.locator("> div").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(["tip-name", "tip-status", "tip-created-by", "tip-project", "tip-branch", "tip-model"]);
    await row(page, "s:s-1").hover();
    await expect(tip).toHaveAttribute("data-thread-id", "s-1");
    await expect(tip.getByTestId("tip-created-by")).toHaveCount(0);
  });

  test("header: the crumb names the creator, which opens; the timeline opens with the Created by note", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    await openFromCard(page, C, "Add retry to login redirect");
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
    await openFromCard(page, C, "Add retry to login redirect");
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

  test("header: a removed creator leaves an inert crumb segment saying so, with the recorded name; the orphan joins the sidebar", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    await openFromCard(page, C, "Add retry to login redirect");
    await openFromCard(page, "s-l-grand", "Write retry backoff tests");
    await expect(parent(page)).toHaveText("Add retry to login redirect");
    await expect(parent(page)).not.toHaveAttribute("data-removed", "true");
    // Hidden, so P's row (its nearest shown ancestor) is the highlighted one.
    await expect(row(page, "s:s-l-grand")).toHaveCount(0);
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");
    await mockPost(`thread/forget?id=${C}`);
    // Gone from the list: the name the thread recorded when it was created.
    await expect(parent(page)).toHaveAttribute("data-removed", "true");
    await expect(parent(page)).toHaveText("Add retry to login redirect (old)");
    // Its creator gone, the thread is the user's: its own row, highlighted.
    await expect(row(page, "s:s-l-grand")).toHaveAttribute("aria-selected", "true");
    await expect(row(page, `s:${P}`)).not.toHaveAttribute("aria-selected", "true");
    await expectTooltip(page, parent(page), "Thread removed");
    await parent(page).click();
    await expect(header(page).getByTestId("thread-title")).toHaveText("Write retry backoff tests");
    await expect(page.getByTestId("thread-created-by-note-link")).toHaveCount(0);
    await expect(page.getByTestId("thread-created-by-note-name")).toHaveText("Add retry to login redirect (old)");
  });
});

test.describe("child threads", () => {
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

  test("are not in the attention count while their creator exists; orphaned, the waiting ones count", async ({ page }) => {
    await openApp(page);
    await expect(row(page, `s:${P}`)).toBeVisible();
    // C's finished turn, s-l-cookie's permission prompt and s-l-allow's API error are not counted.
    const before = Number(/\((\d+)\)/.exec(await page.title())?.[1] ?? "0");
    // P (working, not counted) goes alone: the three waiting children are the user's now.
    await mockPost(`thread/forget?id=${P}`);
    await expect(row(page, `s:${C}`)).toBeVisible();
    await expectAttention(page, before + 3);
  });

  test("cmd+shift+a and cmd+1..9 walk the shown rows only", async ({ page }) => {
    await openApp(page);
    await expect(row(page, `s:${P}`)).toBeVisible();
    const selectedId = () => page.getByTestId("thread-pane").getAttribute("data-thread-id");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Meta+Shift+a");
      await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
    }
    const keys = await sidebarKeys(page);
    // Main list, then Working (P among them); Snoozed and Archived collapsed. No child.
    expect(keys.filter((k) => ALL.includes(String(k).slice(2)))).toEqual([]);
    for (const n of [1, 5, keys.length]) {
      await page.keyboard.press(`Meta+${String(n)}`);
      await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", String(keys[n - 1]).slice(2));
    }
    // Their creator gone, the waiting orphans join the walk.
    await mockPost(`thread/forget?id=${P}`);
    await expect(row(page, `s:${C}`)).toBeVisible();
    const visited = new Set<string>();
    // Opening a thread can move it within its band (its sort time changes), so the walk's
    // order shifts as it goes: walk until all four were reached, at most twice round.
    for (let i = 0; i < 8 && visited.size < 4; i++) {
      const prev = await selectedId();
      await page.keyboard.press("Meta+Shift+a");
      await expect.poll(selectedId).not.toBe(prev);
      visited.add(String(await selectedId()));
    }
    expect([...visited].sort()).toEqual(["s-2", C, "s-l-allow", "s-l-cookie"].sort());
  });

  test("a child open (from the card): its creator's row is highlighted and arrows move from it; no menu shows or hides it", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    // The lineage group: no eye, no "hidden" word, no Show hidden threads.
    await openCard(page);
    await expect(lineageRow(page, C)).toBeVisible();
    await expect(card(page).getByText("hidden", { exact: true })).toHaveCount(0);
    await card(page).getByTestId("ti-lineage-menu-trigger").click();
    await expect(page.getByTestId("ti-lineage-menu")).toBeVisible();
    await expect(page.getByTestId("ti-show-hidden")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openFromCard(page, C, "Add retry to login redirect");
    await expect(row(page, `s:${C}`)).toHaveCount(0);
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("thread-list").locator('[aria-selected="true"]')).toHaveCount(1);

    // A grandchild (from C's own card): still its nearest shown ancestor, P.
    await openFromCard(page, "s-l-grand", "Write retry backoff tests");
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");

    // Arrow keys start from the highlighted row.
    const keys = await sidebarKeys(page);
    const next = keys[keys.indexOf(`s:${P}`) + 1];
    const list = page.getByTestId("thread-list");
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toHaveAttribute("aria-activedescendant", `row-${String(next)}`);

    // The title menu has no Show / Hide in sidebar, on the child or on the user's own thread.
    const title = header(page).getByTestId("thread-title");
    const menu = page.getByTestId("thread-title-menu");
    for (const id of ["s-l-grand", P]) {
      if (id === P) await open(page, P);
      await title.click();
      await expect(menu.getByTestId("menu-archive")).toBeVisible();
      await expect(menu).not.toContainText("sidebar");
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
    // Nor the row menu of an orphan.
    await mockPost(`thread/forget?id=${P}`);
    await row(page, `s:${C}`).click({ button: "right" });
    const rowMenu = page.getByTestId("row-menu");
    await expect(rowMenu.getByTestId("menu-archive")).toBeVisible();
    await expect(rowMenu).not.toContainText("sidebar");
  });

  test("a thread an agent creates does not take the view", async ({ page }) => {
    await openApp(page);
    await open(page, "s-3");
    const title = header(page).getByTestId("thread-title");
    await expect(title).not.toHaveText("");
    const before = await title.textContent();
    const made = await invoke("thread.new", { project: "repo-cf", "created-by": P, name: "Quiet worker", prompt: "work quietly" }, { activeProjectId: "repo-cf" });
    expect(made.message).toMatch(/^created thread s-new-\d+ in /);
    const id = /s-new-\d+/.exec(made.message ?? "")?.[0] ?? "";
    // Give the intent time to land, then check nothing moved.
    await page.waitForTimeout(500);
    await expect(title).toHaveText(String(before));
    await expect(row(page, `s:${id}`)).toHaveCount(0);
  });

  test("archiving the creator asks (its working children counted), then archives every child with it", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    await header(page).getByTestId("thread-title").click();
    await page.getByTestId("thread-title-menu").getByTestId("menu-archive").click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toContainText(
      "Archive thread Fix login redirect? Claude is still working; archiving ends the turn. 2 child threads are still working; archiving ends their turns and archives them too.",
    );
    await page.getByTestId("confirm-ok").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await archivedIds()).sort()).toEqual([P, ...ALL, "s-7"].sort());
    // Under Archived: P only (its children stay out there too).
    await page.getByTestId("archived-header").click();
    await expect(row(page, `s:${P}`)).toHaveAttribute("data-section", "archived");
    for (const id of ALL) await expect(row(page, `s:${id}`)).toHaveCount(0);
  });
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await open(page, P);
    await openFromCard(page, C, "Add retry to login redirect");
    await openCard(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/lineage-mock-${scheme}.png` });
  });
}
