import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The cold-cache note of a rendered thread's composer
 * (docs/notes/rendered-threads-cold-cache.md) over the mock's "Fix stale PR badge"
 * (25.7K tokens of context, answered by claude-opus-4-8, last result 2 minutes ago, TTL
 * 1 h). Set SHOTS=<dir> to save screenshots (in both schemes: the light pass runs only then,
 * nothing here is theme-specific).
 */

test.beforeEach(async () => {
  await resetMock();
});

const NOTE = "Cache expired · the next message re-reads 25.7K tokens (~$0.26)";

async function openThread(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.getByTestId("thread-pane").screenshot({ path: `${dir}/${name}.png` });
}

const note = (page: Page) => page.getByTestId("thread-composer").getByTestId("thread-cold-cache");

const schemes = process.env.SHOTS ? (["dark", "light"] as const) : (["dark"] as const);

for (const scheme of schemes) {
  test(`${scheme}: an expired cache shows the note above the prompt; sending hides it, the next result keeps it hidden`, async ({ page }) => {
    await openThread(page, scheme);
    // Warm: nothing.
    await expect(note(page)).toBeHidden();

    // The last result an hour and a minute ago: the thread update shows it at once.
    await mockPost("thread/cache?id=s-r1&ago=3660");
    await expect(note(page)).toHaveText(NOTE);
    // Inside the card, above the prompt.
    const n = await note(page).boundingBox();
    const editor = await page.getByTestId("thread-composer").locator('[contenteditable="true"]').boundingBox();
    expect(n && editor && n.y + n.height <= editor.y + 1).toBe(true);
    await shot(page, `thread-cold-cache-${scheme}`);

    await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
    await page.keyboard.type("Pick it up again");
    await page.keyboard.press("Enter");
    // Gone as the send starts, and while Claude works.
    await expect(note(page)).toBeHidden();
    await expect(page.getByTestId("thread-interrupt")).toBeVisible();
    await expect(note(page)).toBeHidden();
    // The reply's result is fresh: still hidden once idle.
    await expect(page.getByTestId("thread-pane").locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.");
    await expect(page.getByTestId("thread-interrupt")).toBeHidden();
    await expect(note(page)).toBeHidden();
  });
}

// The note on the composer's own timer, and hidden by a pending prompt: unit-tested in
// src/components/thread/ColdCacheNote.test.tsx.
