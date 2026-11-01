import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Dictation in the GUI (docs/notes/dictation-4-gui.md) against the mock's DictationService
 * (mock/dictation.ts), for what needs the browser: the settings search scrolling to the
 * section, the mic's place, phrases landing in the real editor, Escape in it, switching
 * composers across routes, and ⌘⇧M. The rest is unit-tested (see the pointers below).
 * A mock session plays levels and two phrases 1 s apart.
 */

test.beforeEach(async () => {
  await resetMock();
});

interface DictationMock {
  state: string;
  enabled: boolean;
  downloaded: boolean;
  session: { id: string; clientId: string } | null;
  calls: string[];
}

async function dictation(): Promise<DictationMock> {
  return (await (await fetch(`${mockUrl}/__mock/dictation`)).json()) as DictationMock;
}

async function openThread(page: Page, id = "s-3"): Promise<Locator> {
  await openApp(page);
  await row(page, `s:${id}`).click();
  const card = page.getByTestId("thread-composer");
  await expect(card).toBeVisible();
  // The row's hover card outlives the click for a moment; up, it would take the first Escape.
  await card.hover();
  await expect(page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])')).toHaveCount(0);
  return card;
}

function prompt(card: Locator): Locator {
  return card.getByTestId("composer-prompt");
}

test.describe("settings section", () => {
  // The section's states (download, cancel, failure, progress, chip, M1 warning, Remove): unit-tested in src/components/settings/DictationSettings.test.tsx.
  // The keybinding listed: unit-tested in src/components/settings/KeybindingsPage.test.tsx.
  test("the search finds the section, by its switch and by its model", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Meta+Comma");
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await search.fill("dictation");
    await expect(page.getByTestId("settings-results").locator('[data-setting="dictation.enabled"]')).toBeVisible();
    await search.fill("whisper");
    const hit = page.getByTestId("settings-section-hit");
    await expect(hit).toContainText("General › Dictation");
    await hit.click();
    await expect(page.getByTestId("dictation-model-row")).toBeInViewport();
  });
});

test.describe("composer", () => {
  // Listening… in the placeholder, Send while listening (flush, then send), Loading model…, the
  // engine's failure, the microphone-denied line and a session held elsewhere: unit-tested in
  // src/components/thread/ThreadComposerDictation.test.tsx; the PR review composer's mic in
  // src/components/pr/PrReviewComposer.test.tsx.
  test("no mic while dictation is off or has no model", async ({ page }) => {
    const card = await openThread(page);
    await expect(card.getByTestId("thread-attach")).toBeVisible();
    await expect(card.getByTestId("dictation-mic")).toHaveCount(0);
    await mockPost("dictation?state=no-model");
    await expect(card.getByTestId("dictation-mic")).toHaveCount(0);
    await mockPost("dictation?state=ready");
    await expect(card.getByTestId("dictation-mic")).toBeVisible();
    // Left of attach.
    const mic = await card.getByTestId("dictation-mic").boundingBox();
    const attach = await card.getByTestId("thread-attach").boundingBox();
    expect(mic && attach && mic.x < attach.x).toBe(true);
    // Disabling returns it to nothing.
    await mockPost("dictation?state=off");
    await expect(card.getByTestId("dictation-mic")).toHaveCount(0);
  });

  test("listening: the pill, Listening…, phrases land at the caret with a space and a fading tint", async ({ page }) => {
    await mockPost("dictation?state=ready");
    const card = await openThread(page);
    await card.getByTestId("composer-input").click();
    await page.keyboard.type("First.");
    await card.getByTestId("dictation-mic").click();
    const pill = card.getByTestId("dictation-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("aria-label", "Stop dictating");
    await expect(pill).toContainText(/0:0\d/);
    await expect(card.getByTestId("dictation-marker")).toBeVisible();
    await expect(prompt(card)).toHaveAttribute("data-value", "First. Then add a table test for the race.");
    await expect(card.locator(".cf-dictated")).toHaveText("Then add a table test for the race.");
    // The tint goes after about a second.
    await expect(card.locator(".cf-dictated")).toHaveCount(0, { timeout: 3_000 });
    await expect(prompt(card)).toHaveAttribute("data-value", "First. Then add a table test for the race. And run it with the detector on.");
    // Typing goes on while listening.
    await page.keyboard.type(" Typed");
    await expect(prompt(card)).toHaveAttribute("data-value", /detector on\. Typed$/);
    await pill.click();
    await expect(card.getByTestId("dictation-mic")).toBeVisible();
    await expect(card.getByTestId("dictation-marker")).toHaveCount(0);
    expect((await dictation()).calls.at(-1)).toMatch(/^stop dict-\d+ false$/);
  });

  test("Escape in the prompt stops; auto-stop and disabling return to idle", async ({ page }) => {
    await mockPost("dictation?state=ready");
    await mockPost("dictation/script?phrases=&gap=1000");
    const card = await openThread(page);
    await card.getByTestId("composer-input").click();
    await card.getByTestId("dictation-mic").click();
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.getByTestId("dictation-mic")).toBeVisible();

    await card.getByTestId("dictation-mic").click();
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    await mockPost("dictation/end?reason=silence");
    await expect(card.getByTestId("dictation-mic")).toBeVisible();
    await expect(card.getByTestId("dictation-failure")).toHaveCount(0);

    await card.getByTestId("dictation-mic").click();
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    await mockPost("settings/external?dictation.enabled=false");
    await expect(card.getByTestId("dictation-pill")).toHaveCount(0);
    await expect(card.getByTestId("dictation-mic")).toHaveCount(0);
  });

  test("one composer at a time: leaving the dictating composer stops it, and another composer starts its own", async ({ page }) => {
    await mockPost("dictation?state=ready");
    await mockPost("dictation/script?phrases=");
    await openApp(page);
    await row(page, "s:s-3").click();
    const thread = page.getByTestId("thread-composer");
    await thread.getByTestId("dictation-mic").click();
    await expect(thread.getByTestId("dictation-pill")).toBeVisible();
    // The new-thread composer (cmd+N) in the content pane instead: the thread's composer unmounts and stops.
    await page.keyboard.press("Meta+n");
    const palette = page.getByTestId("palette");
    await expect(palette).toHaveAttribute("data-mode", "projects");
    await palette.locator("[data-project]").first().click();
    const card = page.getByTestId("composer-card");
    await expect(card).toBeVisible();
    await card.getByTestId("dictation-mic").click();
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    const d = await dictation();
    expect(d.session?.clientId).not.toMatch(/^thread:/);
    expect(d.calls.filter((c) => c.startsWith("start "))).toHaveLength(2);
    expect(d.calls.filter((c) => c.startsWith("stop "))).toHaveLength(1);
  });

  test("⌘⇧M toggles the focused composer, else the content pane's", async ({ page }) => {
    await mockPost("dictation?state=ready");
    await mockPost("dictation/script?phrases=");
    const card = await openThread(page);
    await card.getByTestId("composer-input").click();
    await page.keyboard.press("Meta+Shift+m");
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    await page.keyboard.press("Meta+Shift+m");
    await expect(card.getByTestId("dictation-mic")).toBeVisible();
    // Nothing focused: the thread's composer.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press("Meta+Shift+m");
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
  });
});
