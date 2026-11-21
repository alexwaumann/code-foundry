import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A running row in a working thread (components/thread/Shimmer.tsx, docs/notes/running-rows.md):
 * what only a real browser shows, the compiled shimmer on a running row's label (and on the
 * live header's "Working") and that it keeps playing under prefers-reduced-motion. Which rows
 * get the running look, and that no spinner renders, is vitest's (rows.test.tsx, agentRows.test.tsx).
 * SHOTS=<dir> saves the PR's screenshots: the strip row, a parallel batch of running tools and
 * running Agent rows, dark and light.
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

/** The streaming thread with `commands` started as running Bash calls after its streamed text. */
async function openRunning(page: Page, commands: readonly string[]): Promise<void> {
  await mockPost("thread?state=streaming");
  for (const c of commands) await mockPost(`thread/tool?command=${encodeURIComponent(c)}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-working")).toBeVisible();
}

/** An element's running animations (name, duration in ms, iterations, state); null when it went (a remount), to poll again. */
function animations(el: Locator): Promise<{ name: string; duration: number; iterations: number; state: string }[] | null> {
  return el.evaluate((e) =>
    e.isConnected
      ? e.getAnimations().map((a) => {
          const t = a.effect?.getComputedTiming();
          return { name: (a as CSSAnimation).animationName, duration: Number(t?.duration ?? 0), iterations: t?.iterations ?? 0, state: a.playState };
        })
      : null,
  );
}

test("under prefers-reduced-motion a running row's label still shimmers, and so does the live header's Working", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openRunning(page, ["go test ./internal/store/pr/..."]);
  const running = page.locator('[data-testid="thread-tool"][data-running="true"]');
  const label = running.locator('.lbl > .shimmer[data-shimmer="row"]');
  await expect(label).toHaveText("Running go test ./internal/store/pr/...");
  await expect.poll(() => animations(label)).toEqual([{ name: "cf-shimmer", duration: 2400, iterations: Infinity, state: "running" }]);
  // The band is the label's own background, clipped to its glyphs, in the theme's text tones;
  // the icon takes the theme's info tone.
  const look = await label.evaluate((el) => {
    const s = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = root.getPropertyValue("--cf-info-text");
    document.body.append(probe);
    const info = getComputedStyle(probe).color;
    probe.remove();
    const icon = el.closest(".row")?.querySelector(".ico svg");
    return { clip: s.backgroundClip, image: s.backgroundImage.startsWith("linear-gradient"), iconColour: icon ? getComputedStyle(icon).color : "", info };
  });
  expect(look.clip).toBe("text");
  expect(look.image).toBe(true);
  expect(look.iconColour).toBe(look.info);
  const working = page.getByTestId("thread-working").locator('.shimmer[data-shimmer="head"]');
  await expect.poll(() => animations(working)).toEqual([{ name: "cf-shimmer", duration: 2000, iterations: Infinity, state: "running" }]);
});

async function clipAround(page: Page, target: Locator, name: string, pad = { x: 12, y: 8, width: 640 }): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name}: no box`);
  await page.screenshot({ path: `${shots ?? ""}/${name}.png`, clip: { x: Math.max(0, box.x - pad.x), y: Math.max(0, box.y - pad.y), width: Math.max(box.width, pad.width) + 2 * pad.x, height: box.height + 2 * pad.y }, scale: "device" });
}

for (const scheme of ["dark", "light"] as const) {
  test(`running rows screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRunning(page, ["go test ./internal/store/pr/...", "ruff check .", "mypy sorts/"]);
    await page.mouse.move(1270, 890);
    // 1 · the collapsed strip row: the latest step running under the Working pill.
    const strip = page.locator('[data-testid="thread-strip-row"][data-running="true"]');
    await strip.scrollIntoViewIfNeeded();
    await clipAround(page, strip, `strip-row-${scheme}`, { x: 16, y: 40, width: 640 });
    // 2 · the strip open: three tools running in parallel.
    await strip.click();
    await page.mouse.move(1270, 890);
    const open = page.locator('[data-testid="thread-strip"][data-open]').last();
    await expect(open.locator('[data-running="true"]')).toHaveCount(3);
    await clipAround(page, open, `tool-rows-${scheme}`);
    // 3 · background Agent runs among finished ones, the turn unfolded.
    await mockPost("thread?state=agents");
    await page.getByRole("button", { name: /Show this turn/ }).first().click();
    await page.mouse.move(1270, 890);
    await expect(page.locator('[data-tool="Agent"] [data-running="true"]')).toHaveCount(2);
    const boxes = (await Promise.all((await page.locator("[data-tool]").all()).map((l) => l.boundingBox()))).filter((b) => b !== null);
    const top = Math.min(...boxes.map((b) => b.y));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    const left = Math.min(...boxes.map((b) => b.x));
    const width = Math.max(...boxes.map((b) => b.width));
    await page.screenshot({ path: `${shots ?? ""}/agent-rows-${scheme}.png`, clip: { x: left - 12, y: top - 8, width: width + 24, height: bottom - top + 16 }, scale: "device" });
  });
}
