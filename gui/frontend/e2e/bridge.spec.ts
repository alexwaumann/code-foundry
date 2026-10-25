import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * The bridge (docs/notes/bridge-2-gui.md): mock/bridge-page.html, shown inline by the
 * scripted thread's "bridge" state (mock/thread.ts, a working turn), loads /cf/bridge.js
 * (the daemon's script, served by the mock) and calls Code Foundry through its frame's
 * host. SHOTS=<dir> saves the card in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

const shots = process.env.SHOTS;

const card = (page: Page) => page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-card");
const doc = (page: Page) => card(page).frameLocator('[data-testid="thread-html-frame"]');

async function openBridgeThread(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=bridge");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(card(page)).toBeVisible();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
}

interface Counters {
  hosts: number;
  subscriptions: number;
  posts: number;
}

/** The app's dev hook (stores/bridgeHost.ts): live hosts, their subscriptions, posts so far. */
const bridgeCounters = (page: Page): Promise<Counters> => page.evaluate(() => ({ ...((window as { __cfBridge?: Counters }).__cfBridge ?? { hosts: -1, subscriptions: -1, posts: -1 }) }));

test("a page in a thread is ready with its thread, the read-only verbs and the sources", async ({ page }) => {
  await openBridgeThread(page);
  const body = doc(page).locator("body");
  await expect(doc(page).locator("#thread")).not.toHaveText("no thread");
  await expect(doc(page).locator("#thread")).not.toHaveText("…");
  await expect(body).toHaveAttribute("data-sources", /thread-list/);
  expect(Number(await body.getAttribute("data-readonly"))).toBeGreaterThan(0);
  // cf.storage, read from the daemon in cf:ready.
  await expect(doc(page).locator("#visits")).toHaveText("1");
});

test("cf:run reads and mutates in the thread's context; the daemon's errors come back mapped", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#list").click();
  await expect(doc(page).locator("#list-out")).toHaveText(/^\{"threads":\d+\}$/);
  await doc(page).locator("#notify").click();
  await expect(doc(page).locator("#notify-out")).toHaveText("ok");
  await expect(page.getByText("Test info")).toBeVisible();
  const notify = (await invocations()).find((i) => i.name === "ui.notify");
  // The CLI's context inside the thread: the thread and nothing else.
  expect(notify?.context).toMatchObject({ activeThreadId: "s-r1", activeView: "", activeProjectId: "", activeWorktreePath: "" });
  expect(notify?.args).toEqual({ level: "info", title: "Hello from a page", body: "Sent through the bridge" });
  await doc(page).locator("#missing").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^unavailable: /);
  await doc(page).locator("#invalid").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^invalid: .*level/);
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await card(page).screenshot({ path: `${shots}/bridge-card-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
});

test("a verb that asks opens the app's confirm dialog: no is declined, yes runs it confirmed", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // The page's title, as shown with it (view.inline --title / the page's <title>).
  await expect(dialog.getByTestId("confirm-caller")).toContainText("Bridge check, a page in");
  if (shots) await page.screenshot({ path: `${shots}/bridge-confirm.png` });
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(doc(page).locator("#archive-out")).toHaveText(/^declined: /);
  expect((await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.confirmed)).toEqual([false]);
  await doc(page).locator("#archive").click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-ok").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.confirmed)).toEqual([false, false, true]);
});

test("a subscription delivers the snapshot, then every change; closing the card lets go of everything", async ({ page }) => {
  await openBridgeThread(page);
  const rows = doc(page).locator("#rows");
  await expect(rows).not.toHaveText("–");
  const before = Number(await rows.textContent());
  expect(Number(await doc(page).locator("#events").textContent())).toBeGreaterThanOrEqual(1);
  await mockPost(`threads?project=repo-cf&count=2&status=idle&prefix=Bridge`);
  await expect(rows).toHaveText(String(before + 2));
  await expect.poll(async () => (await bridgeCounters(page)).subscriptions).toBe(1);
  // Close the card: its frame goes, and its host stops.
  await page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row").click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(async () => bridgeCounters(page)).toMatchObject({ hosts: 0, subscriptions: 0 });
  const posts = (await bridgeCounters(page)).posts;
  await mockPost(`threads?project=repo-cf&count=2&status=idle&prefix=After`);
  await page.waitForTimeout(400);
  expect((await bridgeCounters(page)).posts).toBe(posts);
});

test("a call waiting on the app's confirm dialog, open or queued, does not time out", async ({ page }) => {
  await openBridgeThread(page);
  const restarts = async () => (await invocations()).filter((i) => i.name === "thread.restart").map((i) => i.confirmed);
  // One click, two questions, each call with a 1 s timeout.
  await doc(page).locator("#twice").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(1500);
  await dialog.getByTestId("confirm-ok").click();
  await expect.poll(restarts).toEqual([false, false, true]);
  // The second waited behind the first for longer than its timeout, then opens.
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(doc(page).locator("#twice-out")).toHaveText("");
  await dialog.getByTestId("confirm-ok").click();
  await expect(doc(page).locator("#twice-out")).toHaveText("1 ok, 2 ok");
  expect(await restarts()).toEqual([false, false, true, true]);
});

test("a page that goes while its question is open takes the question with it, and the command never runs", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // The page reloads itself (the app's dialog is modal, so the user cannot close the card now).
  await doc(page).locator("body").evaluate(() => {
    location.reload();
  });
  await expect(dialog).toHaveCount(0);
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  await page.waitForTimeout(400);
  expect((await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.confirmed)).toEqual([false]);
});

test("cf.on with a source that is not one throws in the page", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#typo").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^invalid: cf\.on: no source threads; the sources are thread-list, thread, /);
});

test("storage is the daemon's: a fresh browser profile reads what the page stored", async ({ page, browser }) => {
  await openBridgeThread(page);
  await expect(doc(page).locator("#visits")).toHaveText("1");
  // A new context has no localStorage of the old one, as a relaunched app's frame has none.
  const fresh = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const again = await fresh.newPage();
    await openBridgeThread(again);
    await expect(doc(again).locator("#visits")).toHaveText("2");
  } finally {
    await fresh.close();
  }
});

test("storage survives a reload; a theme switch reaches the page without one", async ({ page }) => {
  await openBridgeThread(page);
  await expect(doc(page).locator("#visits")).toHaveText("1");
  // Closing and opening the card loads the page again.
  const pageRow = page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row");
  await pageRow.click();
  await expect(card(page)).toHaveCount(0);
  await pageRow.click();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  await expect(doc(page).locator("#visits")).toHaveText("2");
  const scheme = await doc(page).locator("#theme").textContent();
  await page.emulateMedia({ colorScheme: scheme === "dark" ? "light" : "dark" });
  await expect(doc(page).locator("#theme")).toHaveText(scheme === "dark" ? "light" : "dark");
  // The bridge script applied it and acked: no reload, the same visit.
  await page.waitForTimeout(600);
  await expect(doc(page).locator("#visits")).toHaveText("2");
});

test("a File tab on a page its thread did not show gets a bridge that refuses calls", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path: "docs/bridge.html" });
  await page.evaluate(`import("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  const inner = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(inner.locator("#thread")).toHaveText("no thread");
  await expect(inner.locator("body")).toHaveAttribute("data-readonly", "0");
  await expect(inner.locator("body")).toHaveAttribute("data-sources", "");
  await inner.locator("#notify").click();
  await expect(inner.locator("#notify-out")).toHaveText("unavailable: this page is not shown in a thread");
  expect((await invocations()).some((i) => i.name === "ui.notify")).toBe(false);
});

test("the File tab of a page its thread showed has that thread's bridge", async ({ page }) => {
  await openBridgeThread(page);
  await card(page).getByTestId("thread-html-panel").click();
  const inner = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(inner.locator("#thread")).not.toHaveText("no thread");
  await inner.locator("#notify").click();
  await expect(inner.locator("#notify-out")).toHaveText("ok");
});

test("a page starts a thread without moving the view: its handler runs, the sidebar shows the new row", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#start").click();
  await expect(doc(page).locator("#start-out")).toHaveText(/^started 1: created thread /);
  // The page's own success handling ran: the box is empty, so a second click cannot repeat it.
  await expect(doc(page).locator("#task")).toHaveValue("");
  const call = (await invocations()).find((i) => i.name === "thread.new");
  // The skill's example call, unchanged: no project (the thread's placement), focus off by the host.
  expect(call?.args).toEqual({ prompt: "Reply with OK only.", sidebar: "true", "created-by": "s-r1", focus: "false" });
  await expect(card(page)).toBeVisible();
  await expect(row(page, "s:s-r1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("sidebar").getByText("Reply with OK only")).toBeVisible();
});

test("a page's errors show on its strip; Ask Claude puts them in the thread's composer, not sent", async ({ page }) => {
  await openBridgeThread(page);
  const badge = card(page).getByTestId("page-errors");
  await expect(badge).toHaveCount(0);
  await doc(page).locator("#misspelt").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^invalid: .*unknown argument "archivd"/);
  await doc(page).locator("#misspelt").click();
  await doc(page).locator("#missing").click();
  await expect(badge).toHaveText("3");
  await badge.click();
  const pop = page.getByTestId("page-errors-popover");
  await expect(pop.getByTestId("page-error")).toHaveCount(2);
  await expect(pop.getByTestId("page-error").first()).toContainText("no.such.verb");
  await expect(pop.getByTestId("page-error").last()).toContainText("2×");
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/bridge-errors-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
  await pop.getByTestId("page-errors-ask").click();
  const prompt = page.getByTestId("thread-composer").getByTestId("composer-prompt");
  await expect(prompt).toHaveAttribute("data-value", /^The page Bridge check \(.*bridge\.html\) got these errors from Code Foundry/);
  await expect(prompt).toHaveAttribute("data-value", /thread\.list: invalid: .*archivd.* \(2 times\)/);
  expect((await invocations()).some((i) => i.name === "thread.send")).toBe(false);
  // A reload of the page clears them.
  const pageRow = page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row");
  await pageRow.click();
  await pageRow.click();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  await expect(card(page).getByTestId("page-errors")).toHaveCount(0);
});

test("the panel copy names the page by its title and counts its errors too", async ({ page }) => {
  await openBridgeThread(page);
  await card(page).getByTestId("thread-html-panel").click();
  const inner = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  await inner.locator("#archive").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog.getByTestId("confirm-caller")).toContainText("Bridge check, a page in");
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await inner.locator("#invalid").click();
  await expect(page.getByTestId("file-html-footer").getByTestId("page-errors")).toHaveText("1");
});

/** The frame's nonce, as the page reads it from its own URL (lib/bridge.ts withNonce). */
const NONCE = () => /(?:^#|&)cf=([^&]+)/.exec(location.hash)?.[1] ?? "";

/** The mock's thread.wait calls, each held until its caller aborts it (mock/bridge.ts). */
const mockWaitList = async (): Promise<unknown> => (await fetch(`${mockUrl}/__mock/waits`)).json();

test("a page that leads its frame to another page, another grant's or itself without the nonce, has no bridge there", async ({ page }) => {
  await openBridgeThread(page);
  const other = await page.evaluate(`import("/src/api/files.ts").then((m) => m.previewFile("", "/Users/dev/elsewhere/bridge.html")).then((p) => p.url)`);
  expect(other).toMatch(/\/preview\/mock-preview-\d+\/bridge\.html$/);
  const before = await bridgeCounters(page);
  await doc(page).locator("body").evaluate((_b, url) => {
    location.href = url as string;
  }, other);
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "no");
  await expect(doc(page).locator("#thread")).toHaveText(/^unavailable: this page was not opened by Code Foundry in this frame/);
  await doc(page).locator("#notify").click();
  await expect(doc(page).locator("#notify-out")).toHaveText(/^unavailable: /);
  // A raw run with no nonce, or a guessed one, is not heard either.
  await doc(page).locator("body").evaluate(() => {
    parent.postMessage({ cf: 1, type: "cf:hello" }, "*");
    parent.postMessage({ cf: 1, type: "cf:run", id: "x", verb: "ui.notify", args: { title: "t" }, nonce: "0".repeat(32) }, "*");
  });
  await page.waitForTimeout(400);
  expect((await invocations()).some((i) => i.name === "ui.notify")).toBe(false);
  // The host sent the new document nothing: no cf:ready, no events of the old one's subscription.
  const after = await bridgeCounters(page);
  await mockPost(`threads?project=repo-cf&count=1&status=idle&prefix=Gone`);
  await page.waitForTimeout(400);
  expect((await bridgeCounters(page)).posts).toBe(after.posts);
  expect(after.subscriptions).toBe(before.subscriptions - 1);
  // The bridge page itself, without its fragment: the same.
  await page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row").click();
  await page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row").click();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  await doc(page).locator("body").evaluate(() => {
    location.replace(location.pathname);
  });
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "no");
});

test("a reload keeps the frame's nonce and its bridge", async ({ page }) => {
  await openBridgeThread(page);
  const nonce = await doc(page).locator("body").evaluate(NONCE);
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  await doc(page).locator("body").evaluate(() => {
    location.reload();
  });
  await expect(doc(page).locator("#visits")).toHaveText("2");
  expect(await doc(page).locator("body").evaluate(NONCE)).toBe(nonce);
});

test("a File tab page with no thread is opaque: it cannot reach a thread's page beside it", async ({ page }) => {
  await openBridgeThread(page);
  const target = JSON.stringify({ project: "repo-cf", base: CF, path: "docs/probe.html" });
  await page.evaluate(`import("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  const probe = page.getByTestId("file-html-frame");
  await expect(probe).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(card(page).getByTestId("thread-html-frame")).toHaveAttribute("sandbox", /allow-same-origin/);
  // Every sibling (the thread's inline page at least) throws on access.
  await expect(page.frameLocator('[data-testid="file-html-frame"]').locator("body")).toHaveAttribute("data-probe", /^blocked(,blocked)*$/);
});

test("a run id already in flight is refused, and a page's cancel or reload aborts the daemon's wait", async ({ page }) => {
  await openBridgeThread(page);
  // Raw posts, as a page could send without the script (it reads its own nonce).
  const results = await doc(page)
    .locator("body")
    .evaluate(async () => {
      const nonce = /(?:^#|&)cf=([^&]+)/.exec(location.hash)?.[1] ?? "";
      const got: unknown[] = [];
      addEventListener("message", (e: MessageEvent<{ type?: string; id?: string }>) => {
        if (e.data.type === "cf:result" && e.data.id === "dup") got.push(e.data);
      });
      const run = { cf: 1, type: "cf:run", id: "dup", verb: "thread.wait", args: { id: "s-1" }, nonce };
      parent.postMessage(run, "*");
      parent.postMessage(run, "*");
      await new Promise((r) => setTimeout(r, 500));
      return got;
    });
  expect(results).toEqual([{ type: "cf:result", id: "dup", ok: false, error: { code: "invalid", message: "a call with id dup is already running" } }]);
  await expect.poll(mockWaitList).toEqual([{ args: { id: "s-1" }, aborted: false }]);
  await doc(page)
    .locator("body")
    .evaluate(() => {
      const nonce = /(?:^#|&)cf=([^&]+)/.exec(location.hash)?.[1] ?? "";
      parent.postMessage({ cf: 1, type: "cf:cancel", id: "dup", nonce }, "*");
      parent.postMessage({ cf: 1, type: "cf:run", id: "next", verb: "thread.wait", args: { id: "s-2" }, nonce }, "*");
    });
  await expect.poll(mockWaitList).toEqual([
    { args: { id: "s-1" }, aborted: true },
    { args: { id: "s-2" }, aborted: false },
  ]);
  // The page goes: its wait goes with it.
  await doc(page).locator("body").evaluate(() => {
    location.reload();
  });
  await expect.poll(mockWaitList).toEqual([
    { args: { id: "s-1" }, aborted: true },
    { args: { id: "s-2" }, aborted: true },
  ]);
});

test("the lightbox's copy of a page has its thread's bridge, under a nonce of its own", async ({ page }) => {
  await openBridgeThread(page);
  const cardNonce = await doc(page).locator("body").evaluate(NONCE);
  await card(page).getByTestId("thread-html-expand").click();
  const box = page.getByTestId("thread-html-lightbox");
  const inner = box.frameLocator('[data-testid="thread-html-lightbox-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(inner.locator("#thread")).not.toHaveText("no thread");
  const boxNonce = await inner.locator("body").evaluate(NONCE);
  expect(boxNonce).toMatch(/^[0-9a-f]{32}$/);
  expect(boxNonce).not.toBe(cardNonce);
  await inner.locator("#notify").click();
  await expect(inner.locator("#notify-out")).toHaveText("ok");
});

const mockFetchList = async (): Promise<{ url: string; method: string; headers: Record<string, string>; aborted: boolean }[]> =>
  (await fetch(`${mockUrl}/__mock/fetches`)).json() as Promise<{ url: string; method: string; headers: Record<string, string>; aborted: boolean }[]>;

test("cf.fetch goes through the daemon: the upstream's answer, a 401 as a response, loopback refused invalid; a timeout aborts it", async ({ page }) => {
  await openBridgeThread(page);
  const out = doc(page).locator("#fetch-out");
  await doc(page).locator("#fetch").click();
  await expect(out).toHaveText("200 3 issues");
  await expect(out).toHaveClass(/ok/);
  await doc(page).locator("#fetch-token").click();
  await expect(out).toHaveText("401 bad token");
  const sent = await mockFetchList();
  expect(sent.map((f) => [f.url, f.method, f.headers.Authorization])).toEqual([
    ["https://upstream.test/issues", "GET", "Bearer good"],
    ["https://upstream.test/issues", "GET", "Bearer bad"],
  ]);
  await doc(page).locator("#fetch-local").click();
  await expect(out).toHaveText(/^invalid: 127\.0\.0\.1 is a loopback address/);
  // The strip counts the refusal, by host; a 401 is no error.
  await expect(card(page).getByTestId("page-errors")).toHaveText("1");
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await card(page).screenshot({ path: `${shots}/bridge-fetch-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
  // A page's timeout gives up (cf:cancel, 5 s past its own), which aborts the daemon's request.
  const code = await doc(page)
    .locator("body")
    .evaluate(() =>
      (window as unknown as { cf: { fetch: (u: string, i: object) => Promise<unknown> } }).cf.fetch("https://upstream.test/slow", { timeout: 200 }).then(
        () => "ok",
        (e: unknown) => (e as { code: string }).code,
      ),
    );
  expect(code).toBe("timeout");
  await expect.poll(async () => (await mockFetchList()).find((f) => f.url.endsWith("/slow"))?.aborted).toBe(true);
});
