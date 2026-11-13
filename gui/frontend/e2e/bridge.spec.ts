import { expect, test, type Frame, type Page } from "@playwright/test";
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
  await expect(page.getByText("Hello from a page")).toBeVisible();
  const notify = (await invocations()).find((i) => i.name === "ui.notify");
  // The CLI's context inside the thread: the thread and nothing else.
  expect(notify?.context).toMatchObject({ activeThreadId: "s-r1", activeView: "", activeProjectId: "", activeWorktreePath: "" });
  expect(notify?.args).toEqual({ level: "info", title: "Hello from a page", body: "Sent through the bridge" });
  await doc(page).locator("#missing").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^unavailable: /);
  await doc(page).locator("#invalid").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^invalid: .*title/);
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await card(page).screenshot({ path: `${shots}/bridge-card-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
});

// A verb that asks: no declined, yes run confirmed, the page's title as the caller: src/stores/bridgeHost.test.ts
// ("asks before a verb that wants it…") and src/components/confirm/ConfirmDialog.test.tsx (the caller line); the
// real gesture through a frame is "the panel copy names the page…" below. This keeps the dialog's screenshot.
test("SHOTS: a verb that asks opens the app's confirm dialog", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog.getByTestId("confirm-caller-detail")).toContainText("Bridge check");
  await page.screenshot({ path: `${String(shots)}/bridge-confirm.png` });
  await dialog.getByTestId("confirm-cancel").click();
});

// file.export's rules (paths, replacing, the cap, the page's question) are the daemon's: internal/command/commands_file_export_test.go.
test("a page's Export button saves into its thread's checkout once the user allows it, and shows the path", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#export").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText(`Saves 32 bytes to ${CF}/rows.csv`);
  await expect(dialog.getByTestId("confirm-caller-detail")).toContainText("Bridge check");
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/page-save-question-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
  await expect(dialog.getByTestId("confirm-ok")).toBeEnabled();
  await dialog.getByTestId("confirm-ok").click();
  await expect(doc(page).locator("#export-out")).toHaveText(`Saved to ${CF}/rows.csv`);
  // The app shows where it went too (its actions: src/stores/pageSaved.test.ts).
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Saved rows.csv" });
  await expect(toast).toBeVisible();
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/page-saved-toast-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
  const saved = (await (await fetch(`${mockUrl}/__mock/fs/text?path=${encodeURIComponent(`${CF}/rows.csv`)}`)).json()) as { text: string | null };
  expect(saved.text).toBe("id,name\ns-r1,Fix stale PR badge\n");
  expect((await invocations()).filter((i) => i.name === "file.export").map((i) => i.confirmed)).toEqual([false, true]);
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

// A call waiting on the app's confirm dialog, open or queued, not timing out: src/lib/cfBridgeScript.test.ts ("stops a run's clock while the app asks the user…", "settles a run that was waiting on the user…") and src/stores/bridgeHost.test.ts ("tells the page a call waits on the user…" and "has one question open per frame…").

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

// cf.on with a source that is not one throwing: src/lib/cfBridgeScript.test.ts ("throws at once for a source that is not one…").

test("storage is the daemon's: a fresh browser profile reads what the page stored", async ({ page, browser }) => {
  await openBridgeThread(page);
  await expect(doc(page).locator("#visits")).toHaveText("1");
  // A new context has no localStorage of the old one, as a relaunched app's frame has none.
  const fresh = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const again = await fresh.newPage();
    // The layout is the daemon's: the new window opens on the thread's tab the first one opened.
    await again.setViewportSize({ width: 1300, height: 900 });
    await openApp(again);
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

// A File tab on a page its thread did not show gets a bridge that refuses calls: src/components/files/usePageThread.test.tsx ("a file the thread never showed"), src/stores/bridgeHost.test.ts ("refuses every call without a thread"), src/lib/bridge.test.ts ("ready without a thread offers nothing"); the opaque frame in a browser is "a File tab page with no thread is opaque" below.

// The File tab of a page its thread showed having that thread's bridge: "the panel copy names the page…" below drives a call through it; src/components/files/usePageThread.test.tsx ("a thread's own page").

// A page starting a thread without moving the view, as its thread's child: src/stores/bridgeHost.test.ts (thread.new with created-by and focus=false), src/lib/inSidebar.test.ts (a child of a present creator is out of the sidebar).

// The badge's count, the popover's rows (latest first, "2×"), Ask Claude's text and nothing sent:
// src/components/files/PageErrors.test.tsx; which answers count: src/stores/bridgeHost.test.ts.
test("a page's errors show on its strip; Ask Claude's text lands in the thread's prompt; a reload of the page clears them", async ({ page }) => {
  await openBridgeThread(page);
  const badge = card(page).getByTestId("page-errors");
  await doc(page).locator("#misspelt").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^invalid: .*unknown argument "archivd"/);
  await doc(page).locator("#misspelt").click();
  await doc(page).locator("#missing").click();
  await expect(badge).toHaveText("3");
  await badge.click();
  const pop = page.getByTestId("page-errors-popover");
  await expect(pop).toBeVisible();
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
  await expect(dialog.getByTestId("confirm-caller-detail")).toContainText("Bridge check");
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await inner.locator("#invalid").click();
  await expect(page.getByTestId("file-html-footer").getByTestId("page-errors")).toHaveText("1");
});

/** The frame's nonce, as the page reads it from its own URL (lib/bridge.ts withNonce). */
const NONCE = () => /(?:^#|&)cf=([^&]+)/.exec(location.hash)?.[1] ?? "";

/** The mock's thread.wait calls, each held until its caller aborts it (mock/bridge.ts). */
const mockWaitList = async (): Promise<unknown> => (await fetch(`${mockUrl}/__mock/waits`)).json();

test("a page that leads its frame to another grant's page, or is led to its own from outside, has no bridge there", async ({ page }) => {
  await openBridgeThread(page);
  const other = await page.evaluate(`__cfModule("/src/api/files.ts").then((m) => m.previewFile("", "/Users/dev/elsewhere/bridge.html")).then((p) => p.url)`);
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
  // The bridge page itself, without its fragment, loaded by the app's document rather than by
  // the page: the same.
  await page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row").click();
  await page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row").click();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  await card(page).locator('[data-testid="thread-html-frame"]').evaluate((f: HTMLIFrameElement) => {
    f.src = f.src.replace(/#.*$/, "");
  });
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "no");
});

/**
 * The card's frame, which stays the same Frame across its navigations. A navigation the page
 * makes starts after the click or script that asked for it returns (bridge.js carries it on with
 * location.assign), so waiting for the old document's data-ready proves nothing: wait for the
 * frame to commit the new one (its URL), then for that document's data-ready.
 */
async function cardFrame(page: Page): Promise<Frame> {
  const frame = await card(page).locator('[data-testid="thread-html-frame"]').elementHandle().then((h) => h.contentFrame());
  if (!frame) throw new Error("the card has no frame");
  return frame;
}

/** Waits until the frame shows `file` (its document committed) and that document's bridge is ready. */
async function navigatedTo(page: Page, frame: Frame, file: RegExp): Promise<void> {
  await expect.poll(() => new URL(frame.url()).pathname).toMatch(file);
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
}

test("a page's own other file keeps the bridge, followed by a link or set as its location", async ({ page }) => {
  await openBridgeThread(page);
  const frame = await cardFrame(page);
  const nonce = await doc(page).locator("body").evaluate(NONCE);
  // A link the page adds, followed by the user's click.
  await doc(page).locator("body").evaluate((b) => {
    const a = document.createElement("a");
    a.id = "next";
    a.href = "bridge-next.html#rows";
    a.textContent = "Next";
    b.prepend(a);
  });
  await doc(page).locator("#next").click();
  await navigatedTo(page, frame, /\/bridge-next\.html$/);
  expect(await doc(page).locator("body").evaluate(() => location.pathname)).toMatch(/\/bridge-next\.html$/);
  expect(await doc(page).locator("body").evaluate(() => location.hash)).toBe(`#rows&cf=${nonce}`);
  await doc(page).locator("#list").click();
  await expect(doc(page).locator("#list-out")).toHaveText(/"threads":\d+/);
  // Back to the first file by script.
  await doc(page).locator("body").evaluate(() => {
    location.href = "bridge.html";
  });
  await navigatedTo(page, frame, /\/bridge\.html$/);
  expect(await doc(page).locator("body").evaluate(() => location.pathname)).toMatch(/\/bridge\.html$/);
  expect(await doc(page).locator("body").evaluate(NONCE)).toBe(nonce);
  await doc(page).locator("#list").click();
  await expect(doc(page).locator("#list-out")).toHaveText(/"threads":\d+/);
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
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
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

// Kept: the lightbox frame's own bridge answering (its #thread and a notify round trip) is the
// real iframe's; HtmlFrame.test.tsx has the nonce per frame.
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

// Keys in the frame never reach the app; the bridge forwards an Escape the page left alone
// (cf:key with the frame's nonce), and only the lightbox closes on it (page-library-fixes-b).
test("Escape inside the lightbox's page closes the lightbox unless the page consumed it; the card stays", async ({ page }) => {
  await openBridgeThread(page);
  await card(page).getByTestId("thread-html-expand").click();
  const box = page.getByTestId("thread-html-lightbox");
  const inner = box.frameLocator('[data-testid="thread-html-lightbox-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  // Focus in the page, as after a click into it.
  await inner.locator("#task").click();
  await expect(inner.locator("#task")).toBeFocused();
  // A page overlay that handles Escape prevents its default: the lightbox stays.
  await inner.locator("body").evaluate(() => {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") e.preventDefault();
      },
      { once: true },
    );
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(box).toBeVisible();
  // Without the nonce, cf:key is not heard. The card has no frame of its own meanwhile: the
  // modal's is the file's one frame (inline-page-shows).
  await inner.locator("body").evaluate(() => {
    parent.postMessage({ type: "cf:key", key: "Escape", cf: 1 }, "*");
  });
  await expect(card(page).getByTestId("thread-html-frame")).toHaveCount(0);
  await expect(card(page).getByTestId("thread-html-covered")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(box).toBeVisible();
  // Escape nothing consumed closes the lightbox, and only it.
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  // In the card's frame, Escape does nothing to the card.
  await doc(page).locator("#task").click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByTestId("thread-html-frame")).toBeVisible();
});

// The timeline follows its bottom; a card resizing under the pointer keeps its top instead
// (a filtered list shrinking slid the card ~130 px under the pointer: page-library-fixes-b).
test("a card that shrinks under the pointer keeps its top; without the pointer the timeline keeps its bottom", async ({ page }) => {
  await openBridgeThread(page);
  // The card's height is capped by the pane's: room for the 300 px block under the window shell's top bar and tab strip.
  await page.setViewportSize({ width: 1300, height: 1000 });
  const top = async () => (await card(page).boundingBox())?.y ?? NaN;
  const height = async () => (await card(page).boundingBox())?.height ?? NaN;
  const short = await height();
  // A 300 px block the page adds or drops from a script, or drops with a click on Shrink.
  const block = (add: boolean) =>
    doc(page)
      .locator("body")
      .evaluate((body, add) => {
        if (!add) document.getElementById("tall")?.remove();
        else if (!document.getElementById("tall")) {
          const tall = document.createElement("div");
          tall.id = "tall";
          tall.style.height = "300px";
          body.appendChild(tall);
        }
        if (!document.getElementById("shrink")) {
          const b = document.createElement("button");
          b.id = "shrink";
          b.textContent = "Shrink";
          b.onclick = () => document.getElementById("tall")?.remove();
          body.prepend(b);
        }
      }, add);
  // The pointer elsewhere: the timeline keeps its bottom, so a shrink moves the card down.
  await page.mouse.move(5, 450);
  await block(true);
  await expect.poll(height).toBeGreaterThan(short + 100);
  const tall = await height();
  const grownTop = await top();
  await block(false);
  await expect.poll(height).toBeLessThan(tall - 100);
  await expect.poll(top).toBeGreaterThan(grownTop + 50);
  // The pointer in the page: the same shrink keeps the card's top.
  await block(true);
  await expect.poll(height).toBeGreaterThan(tall - 2);
  await expect.poll(top).toBeLessThan(grownTop + 2);
  const before = await top();
  await doc(page).locator("#shrink").click();
  await expect.poll(height).toBeLessThan(tall - 100);
  await page.waitForTimeout(500);
  expect(Math.abs((await top()) - before)).toBeLessThan(2);
});

const mockFetchList = async (): Promise<{ url: string; method: string; headers: Record<string, string>; aborted: boolean }[]> =>
  (await fetch(`${mockUrl}/__mock/fetches`)).json() as Promise<{ url: string; method: string; headers: Record<string, string>; aborted: boolean }[]>;

// cf.fetch's answers (any status a response, errors by host, the strip's count of a refusal):
// src/stores/bridgeHost.test.ts and src/lib/cfBridgeScript.test.ts; the loopback refusal is the
// daemon's (internal/proxyfetch/proxyfetch_test.go). Here the page's timeout reaching the daemon.
test("cf.fetch: a page's timeout aborts the daemon's request", async ({ page }) => {
  await openBridgeThread(page);
  if (shots) {
    const out = doc(page).locator("#fetch-out");
    await doc(page).locator("#fetch").click();
    await expect(out).toHaveText("200 3 issues");
    await doc(page).locator("#fetch-local").click();
    await expect(card(page).getByTestId("page-errors")).toHaveText("1");
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
