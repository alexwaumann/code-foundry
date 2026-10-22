import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, openApp, resetMock } from "./fixtures";

/**
 * Settings › Memory (docs/notes/memory-page.md) against the mock's app memory
 * (mock/memory.ts): four entries, by s-1 "Refactor sidebar tree", by s-3 "Fix resize race",
 * from the user's terminal, and by s-gone "Usage page polish", which the mock no longer has.
 */

async function openMemory(page: Page): Promise<void> {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-memory").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
}

const rows = (page: Page) => page.getByTestId("memory-row");
const rowWith = (page: Page, text: string) => rows(page).filter({ hasText: text });

test.beforeEach(async () => {
  await resetMock();
});

test("lists every entry with when and by which thread", async ({ page }) => {
  await openMemory(page);
  await expect(page.getByTestId("settings-page-description")).toHaveText("What threads have been told to remember about this app and how they work in it.");
  await expect(page.getByTestId("memory-text")).toHaveText([
    "Never open the side panel on your own; tell me and I will open it",
    "Open PRs as drafts",
    "Explain git terms the first time you use them in a thread",
    "Keep answers short; one paragraph unless I ask for detail",
  ]);
  await expect(page.getByTestId("memory-meta")).toHaveText([
    /^Remembered (today|yesterday) · by Refactor sidebar tree$/,
    /^Remembered (yesterday|2 days ago) · by Fix resize race$/,
    "Remembered 3 days ago",
    /^Remembered on \w{3} \d+ · by Usage page polish \(removed\)$/,
  ]);
  await expect(page.getByTestId("memory-count")).toHaveText("4 of 40");
  await expect(page.getByTestId("memory-footnote")).toHaveText("Applies to new threads at once, and to open threads with their next message after a restart.");
  await expect(page.getByTestId("memory-left-out")).toHaveCount(0);
  // The removed thread is not a link.
  const gone = rowWith(page, "Keep answers short").getByTestId("memory-by");
  await expect(gone).toHaveAttribute("data-state", "removed");
  await expect(gone).not.toHaveRole("button");
  await expectTooltip(page, rowWith(page, "Open PRs").getByTestId("memory-forget"), "Forget");
});

test("a thread's link opens it; an archived one stays a link, struck through", async ({ page }) => {
  await openMemory(page);
  await mockPost("thread/archive?id=s-3");
  const by = rowWith(page, "Open PRs").getByTestId("memory-by");
  await expect(by).toHaveAttribute("data-state", "archived");
  await expect(rowWith(page, "Open PRs").getByTestId("memory-meta")).toContainText("by Fix resize race (archived)");

  await rowWith(page, "Never open").getByTestId("memory-by").click();
  await expect(page.getByTestId("settings-body")).toHaveCount(0);
  await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-1"]')).toBeVisible();
});

test("Forget removes the row live, by its id", async ({ page }) => {
  await openMemory(page);
  await rowWith(page, "Open PRs").getByTestId("memory-forget").click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rowWith(page, "Open PRs")).toHaveCount(0);
  await expect(page.getByTestId("memory-count")).toHaveText("3 of 40");
  expect((await invocations()).some((c) => c.name === "memory.remove" && c.args.id === "open-prs-as-drafts" && !c.args.entry)).toBe(true);
});

test("a stale list: Forget never takes another entry, says the entry is gone and refreshes", async ({ page }) => {
  await openMemory(page);
  // The first entry's file goes by hand and no event says so: the page still shows four.
  await mockPost("memory?drop=never-open-the-side-panel-on-your-own.md&quiet=1");
  await expect(rows(page)).toHaveCount(4);
  await rowWith(page, "Never open").getByTestId("memory-forget").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "That entry is gone; the list was refreshed." })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByTestId("memory-text")).toHaveText([
    "Open PRs as drafts",
    "Explain git terms the first time you use them in a thread",
    "Keep answers short; one paragraph unless I ask for detail",
  ]);
  // Then another row goes, the right one.
  await rowWith(page, "Explain git terms").getByTestId("memory-forget").click();
  await expect(page.getByTestId("memory-text")).toHaveText(["Open PRs as drafts", "Keep answers short; one paragraph unless I ask for detail"]);
});

test("an entry too long for threads is listed, muted, and says why", async ({ page }) => {
  await mockPost("memory?set=long");
  await openMemory(page);
  await expect(rows(page)).toHaveCount(5);
  const long = rowWith(page, "Always write very detailed commit messages");
  await expect(long).toHaveAttribute("data-injected", "false");
  await expect(long.getByTestId("memory-meta")).toHaveText("Added by hand");
  await expect(long.getByTestId("memory-left-out")).toHaveText("Not given to threads: longer than 500 characters. Forget it and say it shorter.");
  await expect(page.getByTestId("memory-left-out")).toHaveCount(1);
});

test("Forget all asks first, then empties the page", async ({ page }) => {
  await openMemory(page);
  await page.getByTestId("memory-forget-all").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Forget every remembered preference? New threads get none.");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Forget all");
  await page.getByTestId("confirm-cancel").click();
  await expect(rows(page)).toHaveCount(4);

  await page.getByTestId("memory-forget-all").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("memory-empty")).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
});

test("empty: what it is for and an example; no Forget all; an entry arrives live", async ({ page }) => {
  await mockPost("memory?set=empty");
  await openMemory(page);
  const empty = page.getByTestId("memory-empty");
  await expect(empty).toContainText("Nothing remembered yet");
  await expect(empty).toContainText("Tell a thread how you like things done and it will be kept here, for every thread in every project.");
  await expect(empty).toContainText("“from now on, open PRs as drafts”");
  await expect(page.getByTestId("memory-count")).toHaveText("0 of 40");
  await expect(page.getByTestId("memory-forget-all")).toHaveCount(0);
  await expect(page.getByTestId("memory-footnote")).toHaveCount(0);

  await mockPost("memory/add?text=Use%20tabs&thread=s-1");
  await expect(page.getByTestId("memory-text")).toHaveText(["Use tabs"]);
  await expect(page.getByTestId("memory-meta")).toHaveText("Remembered just now · by Refactor sidebar tree");
});

test("a thread's Remembered toast links to the page", async ({ page }) => {
  await openApp(page);
  await mockPost("memory/add?text=Always%20use%20tabs&thread=s-1");
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Remembered: Always use tabs" });
  await expect(toast).toContainText('By thread "Refactor sidebar tree".');
  await toast.getByRole("button", { name: "Show in Settings" }).click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
  await expect(page.getByTestId("memory-text").last()).toHaveText("Always use tabs");
});

test("the settings search finds Remembered and opens the page there", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("remembered");
  await expect(page.getByTestId("settings-section-hit")).toHaveText(["Memory › RememberedEvery thread in every project reads these before its first action."]);
  await page.getByTestId("settings-section-hit").click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
  await expect(page.locator('[data-section="remembered"]')).toBeInViewport();
  for (const word of ["forget", "preferences", "standing"]) {
    await page.getByRole("searchbox", { name: "Search settings" }).fill(word);
    await expect(page.getByTestId("settings-section-hit").filter({ hasText: "Memory › Remembered" })).toHaveCount(1);
  }
});

/** SHOTS=<dir>: the page with entries and empty, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMemory(page);
    await expect(rows(page)).toHaveCount(4);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/memory-${scheme}.png` });
    await mockPost("memory?set=long");
    await expect(page.getByTestId("memory-left-out")).toBeVisible();
    await page.getByTestId("memory-left-out").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${String(shots)}/memory-long-${scheme}.png` });
    await mockPost("memory?set=empty");
    await expect(page.getByTestId("memory-empty")).toBeVisible();
    await page.screenshot({ path: `${String(shots)}/memory-empty-${scheme}.png` });
  });
}
