/**
 * Live diagnostic for "a rendered thread stops updating while Claude works"
 * (docs/notes/thread-render-stall.md). Opt-in; how to run it: docs/notes/live-e2e.md.
 *
 * It opens LIVE_STALL_THREAD (else a thread it starts in a new worktree of the scratch
 * project and archives at the end), sends LIVE_STALL_PROMPT with the CLI, and samples three
 * layers every 500 ms while the turn runs: the daemon (ListItems), the GUI's thread store
 * (imported from the Vite dev server: the same module instance the app uses) and the DOM
 * (which virtualized rows are mounted, scroll position). A layer that lags the one below
 * it for several samples is a stall, and the test fails naming the layer.
 *
 * The default prompt is a long turn (12 Write calls and a 400-word summary): a shorter
 * LIVE_STALL_PROMPT keeps a check cheap. Env: LIVE_STALL_THREAD, LIVE_STALL_PROMPT,
 * LIVE_STALL_SECS (default 150), LIVE_STALL_SCROLL=1
 * (scroll up and back down during the turn, like a user reading), LIVE_STALL_IDLE (seconds
 * the Watch stays idle before the prompt is sent), LIVE_STALL_SWITCH (another thread id: switch to
 * it and back every 10 s, like a user glancing at another thread).
 */
import { expect, test } from "@playwright/test";
import { row } from "./fixtures";
import { archiveThreads, cli, cliJson, liveProject, MODEL, openApp, requireLive, rpc, type LiveThread } from "./live";

const SECS = Number(process.env.LIVE_STALL_SECS ?? 150);
const SCROLL = process.env.LIVE_STALL_SCROLL === "1";
const IDLE = Number(process.env.LIVE_STALL_IDLE ?? 0);
const SWITCH = process.env.LIVE_STALL_SWITCH ?? "";
const PROMPT =
  process.env.LIVE_STALL_PROMPT ??
  "Create 12 files named notes/n01.md through notes/n12.md, one Write tool call per file, each a short 8-line poem about a different animal. " +
    "Before each Write, say in one sentence which animal comes next. Then run `ls notes` with Bash, Read three of the files, and finish with a 400-word summary of the poems.";

interface Sample {
  t: number;
  daemonSeq: number;
  daemonItems: number;
  storeSeq: number;
  storeItems: number;
  watch: string;
  rows: number;
  maxIdx: number;
  atBottom: boolean;
  gap: number;
  storeText: number;
  domText: number;
}

/** What the evaluate block reads from the app's modules (typed loosely: e2e has no path aliases). */
interface StoreItem {
  kind: string;
  text?: string;
}
interface StoreModule {
  useThreadStore: {
    getState(): {
      logs: Record<string, { seq: number; order: string[]; byId: Record<string, StoreItem | undefined> } | undefined>;
      folds: Record<string, Record<string, boolean> | undefined>;
      watches: Record<string, { status: string } | undefined>;
    };
  };
  structOf(it: StoreItem): unknown;
}
interface TimelineModule {
  buildTurns(items: unknown[]): unknown[];
  buildRows(turns: unknown[], opts: { fold: (k: string) => boolean | undefined; working: boolean }): unknown[];
}

async function daemonItems(id: string): Promise<{ seq: number; items: number }> {
  const body = await rpc<{ snapshot?: { seq?: string; items?: unknown[] } }>("ThreadService/ListItems", { threadId: id });
  return { seq: Number(body.snapshot?.seq ?? 0), items: body.snapshot?.items?.length ?? 0 };
}

requireLive();

let ID = process.env.LIVE_STALL_THREAD ?? "";
let started = "";
test.beforeAll(() => {
  if (ID) return;
  started = (cliJson("thread", "new", "--project", liveProject().id, "--new-worktree", "--model", MODEL, "--effort", "medium", "--name", "live-stall", "--focus=false") as LiveThread).id;
  ID = started;
});
test.afterAll(() => {
  if (started) archiveThreads(started);
});

test("the timeline keeps up with a long turn", async ({ page }) => {
  test.setTimeout((SECS + IDLE + 60) * 1000);
  await openApp(page);
  await row(page, `s:${ID}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline")).toBeVisible();

  // LIVE_STALL_IDLE: leave the Watch idle first (an idle stream that dies silently would never deliver the turn).
  if (IDLE > 0) await page.waitForTimeout(IDLE * 1000);
  cli("thread", "send", "--id", ID, "--text", PROMPT);
  const samples: Sample[] = [];
  const start = Date.now();
  let quietSince = 0;
  while (Date.now() - start < SECS * 1000) {
    const d = await daemonItems(ID);
    const ui = await page.evaluate(async (id) => {
      // The app's own modules, from the Vite dev server (the same instances the app runs).
      const storeUrl = "/src/stores/thread.ts";
      const timelineUrl = "/src/lib/threadTimeline.ts";
      const store = (await import(/* @vite-ignore */ storeUrl)) as StoreModule;
      const tl = (await import(/* @vite-ignore */ timelineUrl)) as TimelineModule;
      const s = store.useThreadStore.getState();
      const log = s.logs[id];
      const el = document.querySelector<HTMLElement>("[data-testid=thread-timeline]");
      const idx = el ? [...el.querySelectorAll<HTMLElement>("[data-index]")].map((e) => Number(e.dataset.index)) : [];
      const items = log ? log.order.flatMap((i) => (log.byId[i] ? [store.structOf(log.byId[i])] : [])) : [];
      const rows = tl.buildRows(tl.buildTurns(items), { fold: (k: string) => s.folds[id]?.[k], working: false }).length;
      const lastText = log ? [...log.order].reverse().map((i) => log.byId[i]).find((it) => it?.kind === "text") : undefined;
      return {
        storeSeq: log?.seq ?? -1,
        storeItems: log?.order.length ?? -1,
        watch: s.watches[id]?.status ?? "none",
        rows,
        maxIdx: idx.length ? Math.max(...idx) : -1,
        atBottom: el?.dataset.atBottom !== undefined,
        gap: el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1,
        // The last text item's length in the store and the last mounted text row's in the DOM.
        storeText: lastText?.text?.length ?? 0,
        domText: [...(el?.querySelectorAll("[data-testid=thread-text]") ?? [])].at(-1)?.textContent.length ?? 0,
      };
    }, ID);
    const smp: Sample = { t: Date.now() - start, daemonSeq: d.seq, daemonItems: d.items, ...ui };
    samples.push(smp);
    console.log(JSON.stringify(smp));
    if (SCROLL && samples.length % 20 === 10) {
      await page.getByTestId("thread-timeline").hover();
      await page.mouse.wheel(0, -600);
    }
    if (SCROLL && samples.length % 20 === 16) await page.getByTestId("thread-jump-bottom").click({ timeout: 1000 }).catch(() => undefined);
    if (SWITCH && samples.length % 20 === 5) await row(page, `s:${SWITCH}`).click({ timeout: 2000 });
    if (SWITCH && samples.length % 20 === 7) await row(page, `s:${ID}`).click({ timeout: 2000 });
    if (samples.length > 4 && smp.daemonSeq === samples[samples.length - 5]?.daemonSeq) quietSince ||= Date.now();
    else quietSince = 0;
    if (quietSince && Date.now() - quietSince > 15_000) break; // the turn is over
    await page.waitForTimeout(500);
  }

  // A layer stalls when it lags the one below it for 6 samples (3 s) in a row.
  const lag = (f: (s: Sample) => boolean) => samples.some((_, i) => i >= 5 && samples.slice(i - 5, i + 1).every(f));
  const deliveryStall = lag((s) => s.watch === "open" && s.storeSeq < s.daemonSeq && s.storeItems < s.daemonItems);
  const renderStall = lag((s) => s.watch === "open" && s.atBottom && s.maxIdx < s.rows - 1);
  const textStall = lag((s) => s.watch === "open" && s.atBottom && s.domText > 0 && s.domText < s.storeText * 0.8);
  expect({ deliveryStall, renderStall, textStall }).toEqual({ deliveryStall: false, renderStall: false, textStall: false });
});
