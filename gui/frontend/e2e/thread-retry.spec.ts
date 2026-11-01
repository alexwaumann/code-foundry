import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The API-retry note of a rendered thread's composer (docs/notes/api-retry-note.md)
 * over the mock's "Fix stale PR badge". Set SHOTS=<dir> to save screenshots (in both schemes:
 * the light pass runs only then, nothing here is theme-specific).
 */

test.beforeEach(async () => {
  await resetMock();
});

async function openThread(page: Page, scheme: "dark" | "light" = "dark"): Promise<void> {
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

const note = (page: Page) => page.getByTestId("thread-composer").getByTestId("thread-retry");

const schemes = process.env.SHOTS ? (["dark", "light"] as const) : (["dark"] as const);

// The note's text, the thread busy meanwhile (Interrupt), the next frame clearing it, and the
// countdown on the composer's own clock turning into "retrying now": unit-tested in
// src/components/thread/ThreadComposer.test.tsx and src/lib/retryNote.test.ts. Left here: its
// place inside the card, above the real editor.
for (const scheme of schemes) {
  test(`${scheme}: a rate-limit retry's note sits in the card above the prompt`, async ({ page }) => {
    await openThread(page, scheme);
    await mockPost("thread/retry?id=s-r1&in=20&attempt=3&max=10&status=429&error=rate_limit");
    await expect(note(page)).toBeVisible();
    const n = await note(page).boundingBox();
    const editor = await page.getByTestId("thread-composer").locator('[contenteditable="true"]').boundingBox();
    expect(n && editor && n.y + n.height <= editor.y + 1).toBe(true);
    await shot(page, `thread-retry-${scheme}`);
  });
}
