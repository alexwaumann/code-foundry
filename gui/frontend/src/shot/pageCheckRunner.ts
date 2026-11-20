/**
 * The shot page's page checks (code-foundry page.check; docs/notes/page-self-check.md). The
 * host hands one through window.cfShot with a `page`; the runner follows the app's state as
 * an observer (the slices a page's bridge reads), shows the page in a card's frame
 * (PageCheckStage), and once the check (lib/pageCheck.ts) reports, marks <html> and hands the
 * report to the host, which snapshots the frame. The frame and the state it followed go a
 * little after: the host has its snapshot by then, and nothing of the check stays running.
 */
import { create } from "zustand";
import { PageCheck, type PageCheckReport } from "@/lib/pageCheck";
import { useThreadsStore } from "@/stores/threads";

/** A check's settle bound when the request names none, and the bounds it may name (the daemon's PageCheckSettle*). */
export const CHECK_SETTLE_MS = 5000;
const SETTLE_MIN_MS = 200;
const SETTLE_MAX_MS = 10_000;
/** How long the app's state may take to arrive before the page is shown anyway. */
export const STATE_WAIT_MS = 2000;
/** How long after its report a check's frame stays: the host's snapshot is well within it. */
export const TEARDOWN_MS = 5000;

/** What the host asks (gui/shot.go shotPageCheck). */
export interface PageCheckRequest {
  id: string;
  page: { path: string; threadId?: string; settleMs?: number };
}

/** The check on the stage: its page, the thread it acts for, and its collector. */
export interface PageCheckJob {
  id: string;
  path: string;
  /** "" for a page the user allowed, which no thread owns. */
  threadId: string;
  check: PageCheck;
}

/** The page check the shot page shows, and its card frame's height. */
export const usePageCheckStage = create<{ job: PageCheckJob | null; height: number }>(() => ({ job: null, height: 0 }));

/** A page check named by the URL (`?page=<path>&thread=<id>&settleMs=…&id=…`), for a browser and the e2e; null for none. */
export function pageCheckFromSearch(search: string): PageCheckRequest | null {
  const q = new URLSearchParams(search);
  const path = q.get("page") ?? "";
  if (!path) return null;
  const settle = Number(q.get("settleMs") ?? "");
  return { id: q.get("id") ?? "url", page: { path, threadId: q.get("thread") ?? "", ...(settle > 0 ? { settleMs: settle } : {}) } };
}

/** What the runner needs from the page. */
export interface PageCheckRunnerDeps {
  /** Applies the theme as last published. */
  applyTheme: () => Promise<void>;
  /** Follows the app's state as an observer; returns the stop. */
  follow: () => () => void;
  /** The report: marks and the host. */
  report: (id: string, r: PageCheckReport) => void;
}

/** Runs page checks one at a time on the shot page; a new one replaces the one in hand. */
export class PageCheckRunner {
  private readonly deps: PageCheckRunnerDeps;
  private current: { job: PageCheckJob | null; stopFollow: () => void; teardown?: ReturnType<typeof setTimeout> } | null = null;

  constructor(deps: PageCheckRunnerDeps) {
    this.deps = deps;
  }

  async start(req: PageCheckRequest): Promise<void> {
    this.stop();
    const settleMs = Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, req.page.settleMs || CHECK_SETTLE_MS));
    const run: { job: PageCheckJob | null; stopFollow: () => void; teardown?: ReturnType<typeof setTimeout> } = { job: null, stopFollow: this.deps.follow() };
    this.current = run;
    const check = new PageCheck({
      now: () => performance.now(),
      later: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => {
          clearTimeout(t);
        };
      },
      settleMs,
      maxHeight: Math.max(48, window.innerHeight),
      onHeight: (height) => {
        if (this.current === run) usePageCheckStage.setState({ height });
      },
      onDone: (r) => {
        this.deps.report(req.id, r);
        run.teardown = setTimeout(() => {
          if (this.current === run) this.stop();
        }, TEARDOWN_MS);
      },
    });
    run.job = { id: req.id, path: req.page.path, threadId: req.page.threadId ?? "", check };
    // The theme, and the app's threads for the page's sources, before the page starts.
    await Promise.all([this.deps.applyTheme().catch(() => undefined), threadsLoaded(STATE_WAIT_MS)]);
    if (this.current !== run) return;
    usePageCheckStage.setState({ job: run.job, height: check.height() });
  }

  /** Ends the check in hand, reported or not: its frame unmounts and the state it followed stops. */
  stop(): void {
    const run = this.current;
    if (!run) return;
    this.current = null;
    clearTimeout(run.teardown);
    run.job?.check.stop();
    run.stopFollow();
    usePageCheckStage.setState({ job: null, height: 0 });
  }
}

/** Resolves once the threads are listed, or after ms. */
function threadsLoaded(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (useThreadsStore.getState().loaded) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    const unsub = useThreadsStore.subscribe((s) => {
      if (s.loaded) done();
    });
    function done() {
      clearTimeout(t);
      unsub();
      resolve();
    }
  });
}
