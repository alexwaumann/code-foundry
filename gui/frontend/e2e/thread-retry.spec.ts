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

for (const scheme of schemes) {
  test(`${scheme}: a rate-limit retry shows above the prompt while the thread works; the next frame clears it`, async ({ page }) => {
    await openThread(page, scheme);
    await expect(note(page)).toBeHidden();

    await mockPost("thread/retry?id=s-r1&in=20&attempt=3&max=10&status=429&error=rate_limit");
    await expect(note(page)).toHaveText(/^Rate limited · retrying in (20|19) s \(attempt 3 of 10\)$/);
    // Busy meanwhile, like the daemon's thread: the interrupt button shows.
    await expect(page.getByTestId("thread-interrupt")).toBeVisible();
    // Inside the card, above the prompt.
    const n = await note(page).boundingBox();
    const editor = await page.getByTestId("thread-composer").locator('[contenteditable="true"]').boundingBox();
    expect(n && editor && n.y + n.height <= editor.y + 1).toBe(true);
    await shot(page, `thread-retry-${scheme}`);

    await mockPost("thread/retry?id=s-r1&clear=1");
    await expect(note(page)).toBeHidden();
  });
}

test("the countdown runs on the composer's own clock and turns into 'retrying now'", async ({ page }) => {
  await page.clock.install();
  await openThread(page);
  await mockPost("thread/retry?id=s-r1&in=5&attempt=1&max=10&status=529&error=overloaded");
  await expect(note(page)).toHaveText(/^API overloaded · retrying in [45] s \(attempt 1 of 10\)$/);
  await page.clock.runFor(3_000);
  await expect(note(page)).toHaveText(/^API overloaded · retrying in [12] s \(attempt 1 of 10\)$/);
  await page.clock.runFor(4_000);
  await expect(note(page)).toHaveText("API overloaded · retrying now (attempt 1 of 10)");
});
