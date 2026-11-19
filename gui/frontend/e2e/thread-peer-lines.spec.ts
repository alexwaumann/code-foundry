import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * Two lead threads talking (docs/notes/other-thread-lines.md) over the mock's s-pl-a (the
 * sender) and s-pl-b (the receiver), mock/peerLines.ts. What a component test cannot show:
 * a line changing in place in the virtualized list moves no row above it and is not
 * remounted. The grouping, the words, the frozen form, the link and the From row's
 * expansion are unit tested (lib/peerLines.test.ts, components/thread/PeerLine.test.tsx).
 * SHOTS=<dir> saves the PR's screenshots, dark and light.
 */

type State = "waiting" | "replied" | "asked-back" | "workers" | "frozen";

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

async function open(page: Page, state: State, id: string, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`peers?state=${state}`);
  await openApp(page);
  await openRowThread(page, id);
  await expect(page.getByTestId("thread-peer").or(page.getByTestId("thread-from")).first()).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Each mounted row up to the last line: its index, type and top in the list's content. */
async function rowsAbove(page: Page): Promise<string[]> {
  return page.getByTestId("thread-timeline").evaluate((el) => {
    const scroller = el.querySelector(".scroller") ?? el;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-row-type]")];
    const last = rows.map((r) => r.dataset.rowType).lastIndexOf("peer");
    const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
    return rows.slice(0, last + 1).map((r) => `${r.dataset.index ?? ""}:${r.dataset.rowType ?? ""}@${String(Math.round(r.getBoundingClientRect().top - top))}`);
  });
}

const words = (page: Page, thread: string) => page.locator(`[data-testid="thread-peer"][data-thread="${thread}"] [data-testid="thread-peer-words"]`);

test("a line changes in place: the answer moves no row above it and keeps the line", async ({ page }) => {
  await open(page, "waiting", "s-pl-a");
  await expect(words(page, "s-pl-c")).toHaveText("told · no reply needed");
  await expect(words(page, "s-pl-b")).toHaveText("asked · waiting for a reply");
  await shot(page, "peer-waiting-dark");
  const before = await rowsAbove(page);
  const line = page.locator('[data-testid="thread-peer"][data-thread="s-pl-b"]');
  await line.evaluate((el) => {
    (el as HTMLElement & { cfMark?: boolean }).cfMark = true;
  });

  await mockPost("peers/step");
  await expect(words(page, "s-pl-b")).toHaveText("replied");
  await expect(page.getByText("so #798 can merge without waiting on it")).toBeVisible();
  expect(await line.evaluate((el) => (el as HTMLElement & { cfMark?: boolean }).cfMark === true)).toBe(true);
  expect(await rowsAbove(page)).toEqual(before);
});

test("screenshots: both sides in every state, dark and light", async ({ page }) => {
  test.skip(!process.env.SHOTS, "only for the PR's screenshots");
  for (const scheme of ["dark", "light"] as const) {
    for (const state of ["waiting", "replied", "asked-back", "workers", "frozen"] as const) {
      await open(page, state, "s-pl-a", scheme);
      await shot(page, `peer-${state}-${scheme}`);
    }
    await open(page, "frozen", "s-pl-b", scheme);
    await shot(page, `peer-receiver-${scheme}`);
    const from = page.getByTestId("thread-from-line").first();
    await from.scrollIntoViewIfNeeded();
    await from.click();
    await expect(page.getByTestId("thread-from-body").first()).toBeVisible();
    await shot(page, `peer-receiver-open-${scheme}`);
  }
});
