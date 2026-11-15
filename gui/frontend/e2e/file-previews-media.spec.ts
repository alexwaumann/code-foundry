import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, resetMock } from "./fixtures";
import { openThread } from "./shell";

/**
 * The File tab's video and audio player (docs/notes/file-previews-7-media.md) in a real
 * WebKit, streaming the mock's tiny clip and tone: that they play, the clock runs, the
 * scrubber seeks, a file WebKit cannot decode says so, the player's keys leave the window's
 * chords alone, and closing the tab lets go of the stream. Formatting, the state machine, the
 * re-grant and the controls shown are vitest's (src/components/files/previews/media/).
 * SHOTS=<dir> also saves the PR's screenshots.
 */

const file = (page: Page) => page.getByTestId("file-tab");
const player = (page: Page) => file(page).getByTestId("media-player");

/** Opens a File tab beside the thread the way a path chip does (stores/filePanel.ts). */
async function openFile(page: Page, path: string): Promise<void> {
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/${path}`);
}

/** The element's clock, in seconds. */
const clock = (page: Page) => page.evaluate(() => document.querySelector<HTMLMediaElement>('[data-testid="media-element"]')?.currentTime ?? -1);

test.beforeEach(async ({ page }) => {
  await resetMock();
  await openApp(page);
  await openThread(page, "s-1");
});

test("a video plays, its clock runs, the scrubber seeks, and closing the tab lets go of the stream", async ({ page }) => {
  await openFile(page, "docs/media/clip.mp4");
  await expect(file(page).getByTestId("file-meta")).toHaveText("0:03 · 160 × 90 · 3 KB · MP4");
  await expect(player(page).getByTestId("media-duration")).toHaveText("0:03");

  await player(page).getByTestId("media-play").click();
  await expect(player(page)).toHaveAttribute("data-playing", "true");
  await expect.poll(() => clock(page)).toBeGreaterThan(0.5);
  await player(page).getByTestId("media-play").click();
  await expect(player(page)).not.toHaveAttribute("data-playing");

  // A click three quarters along the scrubber seeks there (3 s × 0.75).
  const bar = await player(page).getByTestId("media-scrubber").boundingBox();
  if (!bar) throw new Error("no scrubber");
  await page.mouse.click(bar.x + bar.width * 0.75, bar.y + bar.height / 2);
  await expect.poll(() => clock(page)).toBeGreaterThan(2);
  expect(await clock(page)).toBeLessThan(2.5);
  await expect(player(page).getByTestId("media-time")).toHaveText("0:02");

  await page.evaluate(() => {
    (window as { closedPlayer?: Element | null }).closedPlayer = document.querySelector('[data-testid="media-element"]');
  });
  await page.locator('[data-testid="shell-tab"][data-kind="file"] [data-testid="shell-tab-close"]').click();
  await expect(file(page)).toHaveCount(0);
  const gone = await page.evaluate(() => {
    const el = (window as { closedPlayer?: HTMLMediaElement }).closedPlayer;
    return el ? { src: el.getAttribute("src"), network: el.networkState, paused: el.paused } : null;
  });
  // NETWORK_EMPTY (0): no source, no connection.
  expect(gone).toEqual({ src: null, network: 0, paused: true });
  expect(await page.locator("video, audio").count()).toBe(0);
});

test("the player's keys work inside it and leave the window's chords alone", async ({ page }) => {
  await openFile(page, "docs/media/clip.mp4");
  await expect(player(page).getByTestId("media-duration")).toHaveText("0:03");
  await player(page).getByTestId("media-stage").click();
  await expect(player(page)).toHaveAttribute("data-playing", "true");
  await expect(player(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(player(page)).not.toHaveAttribute("data-playing");
  await page.keyboard.press("m");
  await expect(player(page).getByTestId("media-mute")).toHaveAttribute("aria-label", "Unmute");
  // cmd+k is the window's: the palette opens over the player.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
});

test("audio plays to its end", async ({ page }) => {
  await openFile(page, "docs/media/tone.m4a");
  await expect(file(page).getByTestId("file-meta")).toHaveText("0:02 · 8 KB · M4A");
  await player(page).getByTestId("media-play").click();
  await expect(player(page).getByTestId("media-time")).toHaveText("0:02");
  await expect(player(page)).not.toHaveAttribute("data-playing");
});

test("a file WebKit cannot decode says so, with Open in Finder; no black box", async ({ page }) => {
  await openFile(page, "docs/media/broken.webm");
  const state = file(page).getByTestId("file-media-unplayable");
  await expect(state).toContainText("This video format cannot be played here");
  await expect(state.getByRole("button", { name: "Open in Finder" })).toBeVisible();
  await expect(file(page).getByTestId("media-controls")).toHaveCount(0);
});

const shots = process.env.SHOTS;

test("media player screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1400, height: 900 });
  const shot = async (name: string, prepare?: () => Promise<void>) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await prepare?.();
      await page.waitForTimeout(250);
      await page.getByTestId("shell-pane").filter({ has: file(page) }).screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openFile(page, "docs/media/clip.mp4");
  await expect(player(page).getByTestId("media-duration")).toHaveText("0:03");
  const scrubTo = async (fraction: number) => {
    const bar = await player(page).getByTestId("media-scrubber").boundingBox();
    if (!bar) throw new Error("no scrubber");
    await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
  };
  await scrubTo(0.4);
  await expect(player(page).getByTestId("media-time")).toHaveText("0:01");
  await page.mouse.move(0, 0);
  await shot("video-paused");

  // Playing at half speed (6 s of clip), with the speed menu open.
  await page.evaluate(`__cfModule("/src/stores/mediaPlayer.ts").then((m) => m.setPlaybackRate(0.5))`);
  await shot("video-playing-speed", async () => {
    if (await page.getByTestId("media-speed-menu").isVisible()) await page.keyboard.press("Escape");
    await scrubTo(0.1);
    if ((await player(page).getAttribute("data-playing")) === null) await player(page).getByTestId("media-stage").click();
    await expect(player(page)).toHaveAttribute("data-playing", "true");
    await player(page).getByTestId("media-speed").click();
    await expect(page.getByTestId("media-speed-menu")).toBeVisible();
  });
  await page.keyboard.press("Escape");
  await page.evaluate(`__cfModule("/src/stores/mediaPlayer.ts").then((m) => m.setPlaybackRate(1))`);

  await shot("volume-open", async () => {
    await player(page).getByTestId("media-mute").hover();
  });
  await page.mouse.move(0, 0);

  await openFile(page, "docs/media/tone.m4a");
  await expect(player(page).getByTestId("media-duration")).toHaveText("0:02");
  await scrubTo(0.3);
  await page.mouse.move(0, 0);
  await shot("audio");

  await openFile(page, "docs/media/broken.webm");
  await expect(file(page).getByTestId("file-media-unplayable")).toBeVisible();
  await shot("cannot-play");
});
