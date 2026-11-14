import { expect, test, type Locator, type Page } from "@playwright/test";
import { leaveSidebar, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Dictation in the GUI (docs/notes/dictation-4-gui.md) against the mock's DictationService
 * (mock/dictation.ts), for what needs the browser: the settings search scrolling to the
 * section, the mic's place, phrases landing in the real editor, Escape in it, switching
 * composers across routes, and a chord bound to dictation.toggle. The rest is unit-tested (see the pointers below).
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
  await leaveSidebar(page, card);
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
  // No mic while off or without a model, its place before attach, and none once turned off: unit-tested in
  // src/components/thread/ThreadComposerDictation.test.tsx.

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

  test("a spoken line break starts a paragraph, and the caret goes on from it", async ({ page }) => {
    // What the daemon sends for "First." "New line." "Second." (Go tests the words, vitest the slice.)
    await mockPost("dictation?state=ready");
    await mockPost(`dictation/script?phrases=${encodeURIComponent("First.|\n|Second.")}&gap=100`);
    const card = await openThread(page);
    await card.getByTestId("composer-input").click();
    await card.getByTestId("dictation-mic").click();
    await expect(prompt(card)).toHaveAttribute("data-value", "First.\nSecond.");
    await expect(card.getByTestId("composer-input").locator("p")).toHaveCount(2);
    await page.keyboard.type(" Typed");
    await expect(prompt(card)).toHaveAttribute("data-value", "First.\nSecond. Typed");
  });

  test("Escape in the prompt stops", async ({ page }) => {
    await mockPost("dictation?state=ready");
    await mockPost("dictation/script?phrases=&gap=1000");
    const card = await openThread(page);
    await card.getByTestId("composer-input").click();
    await card.getByTestId("dictation-mic").click();
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.getByTestId("dictation-mic")).toBeVisible();

    // An auto-stop and turning dictation off returning to idle: unit-tested in
    // src/components/thread/ThreadComposerDictation.test.tsx.
  });

  test("leaving the dictating composer for the new-thread composer (cmd+N) stops it", async ({ page }) => {
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
    await expect(page.getByTestId("composer-card")).toBeVisible();
    // Another composer starting its own session: unit-tested in src/components/thread/ThreadComposerDictation.test.tsx.
    await expect.poll(async () => (await dictation()).calls.filter((c) => c.startsWith("stop "))).toHaveLength(1);
  });

  test("a chord bound to dictation.toggle toggles the focused composer, else the content pane's", async ({ page }) => {
    await mockPost("settings/external?keybindings.dictation.toggle=cmd%2Bshift%2By");
    await mockPost("dictation?state=ready");
    await mockPost("dictation/script?phrases=");
    const card = await openThread(page);
    await card.getByTestId("composer-input").click();
    await page.keyboard.press("Meta+Shift+y");
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
    await page.keyboard.press("Meta+Shift+y");
    await expect(card.getByTestId("dictation-mic")).toBeVisible();
    // Nothing focused: the thread's composer.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press("Meta+Shift+y");
    await expect(card.getByTestId("dictation-pill")).toBeVisible();
  });
});

/** SHOTS=<dir>: the hold key's permission row, the Advanced rows and the Microphone row, for the PR body, in both schemes. */
test.describe("shots", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`the Microphone row, ${scheme}`, async ({ page }) => {
      const dir = process.env.SHOTS;
      test.skip(!dir, "SHOTS=<dir> only");
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 1200 });
      await mockPost("dictation?state=ready&access=granted&mic=avoiding");
      await openApp(page);
      await page.keyboard.press("Meta+Comma");
      const section = page.locator('[data-section="dictation"]');
      const row = section.locator('[data-setting="dictation.microphone"]');
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500); // the settings sheet's fade
      await page.getByTestId("settings-advanced-toggle").click();
      await expect(row).toContainText("AirPods Pro are Bluetooth");
      await section.screenshot({ path: `${dir ?? ""}/mic-avoiding-${scheme}.png` });
      await page.getByTestId("settings-advanced-toggle").click();
      await mockPost("dictation?mic=plain");
      await row.getByRole("combobox").click();
      await expect(page.getByRole("option", { name: /Shure MV7/ })).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${dir ?? ""}/mic-menu-${scheme}.png` });
      await page.getByRole("option", { name: /Shure MV7/ }).click();
      await mockPost("dictation?mic=named");
      await expect(row).toContainText("Always listens");
      await row.screenshot({ path: `${dir ?? ""}/mic-named-${scheme}.png` });
      await mockPost("dictation?mic=missing");
      await expect(row).toContainText("Shure MV7 isn’t connected");
      await expect(row.getByRole("combobox")).toHaveText("Shure MV7", { useInnerText: true });
      await row.screenshot({ path: `${dir ?? ""}/mic-missing-${scheme}.png` });
    });
    test(`the Advanced rows, ${scheme}`, async ({ page }) => {
      const dir = process.env.SHOTS;
      test.skip(!dir, "SHOTS=<dir> only");
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 1200 });
      await mockPost("dictation?state=ready&access=granted");
      await openApp(page);
      await page.keyboard.press("Meta+Comma");
      const section = page.locator('[data-section="dictation"]');
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500); // the settings sheet's fade
      await section.screenshot({ path: `${dir ?? ""}/advanced-closed-${scheme}.png` });
      await page.getByTestId("settings-advanced-toggle").click();
      await expect(page.getByTestId("settings-advanced")).toBeVisible();
      await section.screenshot({ path: `${dir ?? ""}/advanced-open-${scheme}.png` });
    });
    test(`the permission row, ${scheme}`, async ({ page }) => {
      const dir = process.env.SHOTS;
      test.skip(!dir, "SHOTS=<dir> only");
      await page.emulateMedia({ colorScheme: scheme });
      await page.clock.install();
      await mockPost("dictation?state=ready&access=missing");
      await openApp(page);
      await page.keyboard.press("Meta+Comma");
      const section = page.locator('[data-section="dictation"]');
      const row = page.getByTestId("dictation-access-row");
      await expect(row).toHaveAttribute("data-state", "ask");
      await page.waitForTimeout(500); // the settings sheet's fade
      await section.screenshot({ path: `${dir ?? ""}/ask-${scheme}.png` });
      await page.getByTestId("dictation-allow").click();
      await page.clock.fastForward(31_000);
      await expect(row).toHaveAttribute("data-state", "stuck");
      await section.screenshot({ path: `${dir ?? ""}/stuck-${scheme}.png` });
      await mockPost("dictation?access=silent");
      await expect(row).toHaveAttribute("data-state", "restart");
      await section.screenshot({ path: `${dir ?? ""}/restart-${scheme}.png` });
      await mockPost("dictation?access=granted");
      await expect(row).toHaveAttribute("data-state", "allowed");
      await section.screenshot({ path: `${dir ?? ""}/allowed-${scheme}.png` });
    });
  }
});
