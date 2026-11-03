import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, mockPost, row } from "./fixtures";

// The Find dialog (search.open; docs/notes/search-4-find-dialog.md), only what needs a
// browser: the cmd+shift+f chord through the keymap, arrow keys in the real dialog moving
// the selection and its preview, and Enter landing in the thread with its find bar on the
// match. Rows, grouping, ranges, selection rules, preview matching and the hand-off calls
// are vitest (lib/threadSearch, api/threadSearch, components/search). Over the mock's idle
// s-r1 "Fix stale PR badge", whose messages say "fingerprint". SHOTS=<dir> saves screenshots.

test.beforeEach(async () => {
  await resetMock();
  await mockPost("thread?state=idle");
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const dialog = (page: Page) => page.getByTestId("search-dialog");
const input = (page: Page) => page.getByTestId("search-input");
const selected = (page: Page) => dialog(page).locator('[data-testid="search-row"][data-selected]');

/** The painted ranges' text by highlight name. */
async function painted(page: Page, names: string[]): Promise<Record<string, string[]>> {
  return page.evaluate((names) => {
    const out: Record<string, string[]> = {};
    for (const name of names) {
      const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(name);
      out[name] = h ? [...h].map((r) => r.toString()) : [];
    }
    return out;
  }, names);
}

test("cmd+shift+f opens the dialog anywhere; arrows move through hits; Enter opens the thread at that match", async ({ page }) => {
  await openApp(page);
  // From a page with no thread on screen: the chord still opens it.
  await page.keyboard.press("Meta+Shift+F");
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await shot(page, "search-empty");

  await page.keyboard.type("fingerprint");
  const hits = dialog(page).locator('[data-testid="search-row"][data-kind="hit"][data-thread="s-r1"]');
  await expect(hits.first()).toBeVisible();
  // The first row takes the selection; its message shows on the right, matches painted.
  await expect(selected(page)).toHaveCount(1);
  const first = await selected(page).getAttribute("data-item");
  await expect(page.getByTestId("search-preview-caption")).toContainText("in this message");
  await expect.poll(async () => (await painted(page, ["cf-search-current"]))["cf-search-current"]).toEqual([expect.stringMatching(/^fingerprint$/i)]);
  await shot(page, "search-results");

  // Down moves to the next hit; the preview follows.
  await page.keyboard.press("ArrowDown");
  const second = await selected(page).getAttribute("data-item");
  expect(second).not.toBe(first);
  await expect(page.getByTestId("search-preview")).toHaveAttribute("data-thread", "s-r1");
  // Up and down again land on the same row.
  await page.keyboard.press("ArrowUp");
  await expect(selected(page)).toHaveAttribute("data-item", first ?? "");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toHaveAttribute("data-item", second ?? "");

  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeHidden();
  await expect(row(page, "s:s-r1")).toHaveAttribute("aria-selected", "true");
  const bar = page.getByTestId("thread-find");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("thread-find-input")).toHaveValue("fingerprint");
  await expect(page.getByTestId("thread-find-input")).toBeFocused();
  // The current match is in the message that was selected, and on screen.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("cf-find-current");
        const r = h ? [...h][0] : undefined;
        const el = r?.startContainer.parentElement?.closest("[data-find-item]");
        if (!r || !el) return null;
        const box = r.getBoundingClientRect();
        return { item: el.getAttribute("data-find-item"), onScreen: box.top >= 0 && box.bottom <= window.innerHeight };
      }),
    )
    .toEqual({ item: second, onScreen: true });
  // The dialog's paint is gone.
  expect(await painted(page, ["cf-search", "cf-search-current"])).toEqual({ "cf-search": [], "cf-search-current": [] });
  await shot(page, "search-landed");
});
