import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

// Agent search in the search dialog (docs/notes/search-6-agent-gui.md), only what needs a
// browser: the chord and Tab between the modes through the real keymap and focus, ⌘⇧M
// dictating into the dialog's field (not the composer), and Enter on a hit landing in its
// thread with the quote revealed and marked by the cite layer. Event folding, restore,
// Recent searches, the keys' commands and the Find additions are vitest
// (components/search/AgentSearch.test.tsx, lib/agentSearch.test.ts). Over the mock's
// scripted run (mock/agentSearch.ts) and its idle s-r1 "Fix stale PR badge".

test.beforeEach(async () => {
  await resetMock();
  await mockPost("thread?state=idle");
  await mockPost("search?stepMs=60");
});

const dialog = (page: Page) => page.getByTestId("search-dialog");
const input = (page: Page) => page.getByTestId("search-input");

test("cmd+shift+f opens Agent search; Tab switches to Find and back with the query and the keyboard kept", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Shift+F");
  await expect(dialog(page)).toHaveAttribute("data-mode", "agent");
  await expect(input(page)).toBeFocused();
  await page.keyboard.type("stale badge");
  await page.keyboard.press("Tab");
  await expect(dialog(page)).toHaveAttribute("data-mode", "find");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("stale badge");
  // Find searches as it types.
  await expect(dialog(page).locator('[data-testid="search-row"][data-kind="name"]').first()).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(dialog(page)).toHaveAttribute("data-mode", "agent");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("stale badge");
});

test("⌘⇧M while the dialog is open dictates into its field, with the composer's pill in the header", async ({ page }) => {
  await mockPost("dictation?state=ready");
  await mockPost(`dictation/script?phrases=${encodeURIComponent("where did we decide|the badge fix?")}&gap=400`);
  await openApp(page);
  await page.keyboard.press("Meta+Shift+F");
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Meta+Shift+M");
  await expect(page.getByTestId("search-header").getByTestId("dictation-pill")).toBeVisible();
  await expect(input(page)).toHaveValue("where did we decide the badge fix?");
  // Not the composer's.
  await expect(page.getByTestId("dictation-pill")).toHaveCount(1);
  await page.keyboard.press("Meta+Shift+M");
  await expect(page.getByTestId("search-header").getByTestId("dictation-mic")).toBeVisible();
  await expect(input(page)).toBeFocused();
});

test("Enter on a hit opens its thread with the quote revealed and marked as a citation", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Shift+F");
  await page.keyboard.type("where did we decide the badge fix?");
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "done");
  // The first hit is Claude's reply in s-r1; its quote is marked in the preview too.
  const first = dialog(page).locator('[data-testid="agent-hit"][data-n="1"]');
  await expect(first).toHaveAttribute("data-selected", "true");
  const quote = "The fingerprint now includes the head SHA, which the batched GraphQL query already returns";
  await expect.poll(() => marked(page, "cf-search-quote")).toEqual([quote]);

  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeHidden();
  await expect(row(page, "s:s-r1")).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("cf-cite-mark");
        const r = h ? [...h][0] : undefined;
        if (!r) return null;
        const box = r.getBoundingClientRect();
        return { text: r.toString(), onScreen: box.top >= 0 && box.bottom <= window.innerHeight };
      }),
    )
    .toEqual({ text: quote, onScreen: true });
  // Marked opened in the history.
  const state = (await (await fetch(`${mockUrl}/__mock/search`)).json()) as { calls: string[] };
  expect(state.calls.some((c) => /^open-hit q-\w+ 1$/.test(c))).toBe(true);
  // The mark holds until the next click or key.
  await page.keyboard.press("Shift");
  await expect.poll(() => marked(page, "cf-cite-mark")).toEqual([]);
});

async function marked(page: Page, name: string): Promise<string[]> {
  return page.evaluate((name) => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(name);
    return h ? [...h].map((r) => r.toString()) : [];
  }, name);
}

/** SHOTS=<dir>: the done layout (markers against their punctuation) and a restored dialog's cue, in both schemes. */
for (const scheme of ["dark", "light"] as const) {
  test(`agent search screenshots (${scheme})`, async ({ page }) => {
    const dir = process.env.SHOTS;
    test.skip(!dir, "SHOTS=<dir> only");
    await mockPost("search/seed");
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await page.keyboard.press("Meta+Shift+F");
    await page.keyboard.type("where did we decide the badge fix?");
    await page.keyboard.press("Enter");
    await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "done");
    await expect.poll(() => marked(page, "cf-search-quote")).not.toEqual([]);
    await page.screenshot({ path: `${dir ?? ""}/done-${scheme}.png` });

    // A second question left running while the first is shown again, then closed.
    await mockPost("search?stepMs=300");
    await page.keyboard.press("Meta+Backspace");
    await page.keyboard.type("why did the PR badge stay green after a force-push?");
    await page.keyboard.press("Enter");
    await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "running");
    await page.keyboard.press("Meta+Backspace");
    await dialog(page).locator('[data-testid="search-recent-row"]', { hasText: "where did we decide the badge fix?" }).click();
    await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "done");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect
      .poll(async () => ((await (await fetch(`${mockUrl}/__mock/search`)).json()) as { entries: { query: string; status: number }[] }).entries.find((e) => e.query.startsWith("why did the PR badge"))?.status, { timeout: 15_000 })
      .not.toBe(1);
    await page.keyboard.press("Meta+Shift+F");
    await expect(dialog(page).getByTestId("search-unseen-cue")).toBeVisible();
    await expect.poll(() => marked(page, "cf-search-quote")).not.toEqual([]);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${dir ?? ""}/cue-${scheme}.png` });
  });
}
