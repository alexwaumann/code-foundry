import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

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
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  // The tab is the title (the shell's header names the thread only while its tab is cut short).
  await expect(page.locator('[data-testid="shell-tab"][data-kind="thread"][data-active]')).toContainText(title);
}

test.beforeEach(async () => {
  await resetMock();
  await mockPost("lineage");
});

// Children out of the sidebar while their creator exists, in it with ↳ once it is gone, the
// card's "Created by … (removed)" line: src/lib/inSidebar.test.ts, src/lib/tree.test.ts,
// src/components/sidebar/SidebarRow.test.tsx ("SidebarRow created by a thread", "an orphan's card").
// The crumb naming and opening the creator, its order, the Created by note:
// src/components/thread/ThreadParts.test.tsx, src/components/thread/lineageRows.test.tsx, and the
// card's lineage row opening the child: src/components/threadinfo/ThreadInfoCard.test.tsx.

// Timeline: a wake message as a collapsed Woken by note that expands to its payload and collapses again, its link selecting the thread: src/components/thread/lineageRows.test.tsx ("a wake message: …").

// A removed creator's inert crumb segment, its recorded name and "Thread removed", the anchor
// moving to the orphan: ThreadParts.test.tsx, lineageRows.test.tsx, inSidebar.test.ts (sidebarAnchor).

test.describe("child threads", () => {
  // Not in the attention count while their creator exists, counted once orphaned:
  // src/stores/threads.test.ts ("attentionIds leaves out a child thread").

  // cmd+shift+a opens the Needs-you popup of the next thread waiting on the user (shell-model.md, Keys);
  // cmd+1..9 still open the list's rows.
  test("cmd+shift+a and cmd+1..9 walk the shown rows only", async ({ page }) => {
    await openApp(page);
    await expect(row(page, `s:${P}`)).toBeVisible();
    const popup = page.getByTestId("needs-popup");
    // The open popup's thread, or null (read at once: no wait for a popup).
    const popupId = () => page.evaluate(() => document.querySelector('[data-testid="needs-popup"]')?.getAttribute("data-thread-id") ?? null);
    const shownId = () => page.getByTestId("thread-pane").getAttribute("data-thread-id");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Meta+Shift+a");
      await expect(popup).toHaveAttribute("data-thread-id", "s-2");
    }
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    const keys = await sidebarKeys(page);
    // Needs you, Active, then Working (P among them); Snoozed and Archived collapsed. No child.
    expect(keys.filter((k) => ALL.includes(String(k).slice(2)))).toEqual([]);
    for (const n of [1, 5, keys.length]) {
      await page.keyboard.press(`Meta+${String(n)}`);
      await expect.poll(shownId).toBe(String(keys[n - 1]).slice(2));
    }
    // Their creator gone, the orphans join the list's rows, and cmd+N reaches them.
    await mockPost(`thread/forget?id=${P}`);
    await expect(row(page, `s:${C}`)).toHaveAttribute("data-section", "done");
    const n = (await sidebarKeys(page)).indexOf(`s:${C}`) + 1;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
    await page.keyboard.press(`Meta+${String(n)}`);
    await expect.poll(shownId).toBe(C);
    // The orphan asking for a permission joins Needs you and cmd+shift+a's round; s-l-allow's API
    // error is not an ask (shell-25c-keys-drafts.md: it goes to the top of Active), nor is C's
    // finished turn. Opening a thread's popup can drop it from the list (and the round), so walk
    // until both were reached.
    const visited = new Set<string>();
    for (let i = 0; i < 8 && visited.size < 2; i++) {
      const prev = await popupId();
      await page.keyboard.press("Meta+Shift+a");
      await expect.poll(popupId).not.toBe(prev);
      visited.add(String(await popupId()));
    }
    expect([...visited].sort()).toEqual(["s-2", "s-l-cookie"]);
    await expect(row(page, "s:s-l-allow")).toHaveAttribute("data-section", "attention");
  });

  // No Show hidden in the lineage menu (LineageGroup.test.tsx), no sidebar items in the title or row
  // menus (ThreadMenuItems.test.tsx, RowMenu.test.tsx), the anchor (inSidebar.test.ts sidebarAnchor).
  test("a child open (from the card): arrows in the sidebar start from its creator's highlighted row", async ({ page }) => {
    await openApp(page);
    await open(page, P);
    await openFromCard(page, C, "Add retry to login redirect");
    await expect(row(page, `s:${P}`)).toHaveAttribute("aria-selected", "true");
    const keys = await sidebarKeys(page);
    const next = keys[keys.indexOf(`s:${P}`) + 1];
    const list = page.getByTestId("thread-list");
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toHaveAttribute("aria-activedescendant", `row-${String(next)}`);
  });

  // A thread an agent creates not taking the view: src/lib/inSidebar.test.ts (threadFocus "a new created thread") and src/stores/intents.test.ts ("a new child (its creator exists)").

  // Archiving the creator asking (its working children counted) and archiving them with it: the daemon's (internal/command/commands_thread_cascade_test.go); only the creator under Archived: src/lib/inSidebar.test.ts.
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

/** SHOTS=<dir>: the creator's wake notes (a report, a child's question, a finished child with no report), dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`wake notes screenshot (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await open(page, P);
    const notes = page.getByTestId("thread-wake-note");
    await expect(notes).toHaveCount(3);
    await notes.last().scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const box = await page.getByTestId("thread-pane").boundingBox();
    const first = await notes.first().boundingBox();
    const last = await notes.last().boundingBox();
    if (!box || !first || !last) throw new Error("no layout");
    await page.screenshot({ path: `${String(shots)}/wake-notes-${scheme}.png`, clip: { x: box.x, y: first.y - 16, width: box.width, height: last.y + last.height - first.y + 32 } });
  });
}
