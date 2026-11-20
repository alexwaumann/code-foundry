/**
 * A page check (code-foundry page.check; docs/notes/page-self-check.md): what one render of
 * a page saw, collected as it runs, and when it is done. The shot window renders the page in
 * a card's frame (src/shot/PageCheckStage.tsx); the frame (HtmlFrame) taps every event it
 * hears into a PageCheck, which decides when the page has settled and builds the report the
 * host hands the daemon (PageCheckReport in page.proto).
 *
 * Settled: a document of the page answered, the TSX loader (/cf/jsx.js) is not running, no
 * bridge call is in flight, and nothing happened for CHECK_QUIET_MS. Then the frame is
 * pinged once more for the document's height, and if that brought nothing new the report
 * goes. Past the settle bound it goes anyway, saying it did not settle. Pure but for the
 * clock and timers it is handed.
 */
import { DEFAULT_HEIGHT } from "./inlinePage";

/** How long nothing must happen before a page counts as settled. */
export const CHECK_QUIET_MS = 600;
/** How long the last ping waits for the document's answer. */
export const CHECK_ANSWER_MS = 400;
/** How often the check looks. */
export const CHECK_TICK_MS = 100;
/** The most distinct problems a report keeps (repeats are counted). */
export const CHECK_PROBLEMS_MAX = 50;
/** The smallest card frame (lib/inlinePage.ts). */
const MIN_HEIGHT = 48;
/** The check's own pings start here, far from the frame's (HtmlFrame counts from 1). */
const PING_BASE = 1_000_000;

export type CheckProblemKind = "script" | "rejection" | "loader" | "resource" | "bridge" | "unsupported";

export interface CheckProblem {
  kind: CheckProblemKind;
  /** For bridge and unsupported: what the page called. */
  call: string;
  /** For bridge: the bridge error code. */
  code: string;
  message: string;
  /** "page.html:42:13", or the URL that did not load. */
  where: string;
  count: number;
}

/** page.proto's PageCheckReport, as the host takes it. */
export interface PageCheckReport {
  loaded: boolean;
  loader: string;
  problems: CheckProblem[];
  height: number;
  pageHeight: number;
  resized: boolean;
  settleMs: number;
  settled: boolean;
  busy: number;
  storageWrites: number;
  calls: number;
  failure: string;
  shotError: string;
}

/** What a document says of itself: its height, and how far the TSX loader got. */
export interface FrameShape {
  height?: number;
  loader?: string;
}

/** What the frame (HtmlFrame, and the bridge's host through it) tells a check. */
export interface PageCheckTap {
  /** The frame's `load`. */
  loaded: () => void;
  /** A document answered a ping (`cf:here`, with its seq) or the loader ended (`cf:loader`). */
  note: (n: FrameShape & { seq?: number }) => void;
  /** The page asked for its height (`cf:resize`). */
  resize: (height: number) => void;
  problem: (p: Omit<CheckProblem, "count">) => void;
  /** A bridge call started (1) or ended (-1): a run, a fetch, the bridge's ready. */
  busy: (delta: 1 | -1) => void;
  /** The page made a bridge call or subscription. */
  call: () => void;
  /** The page wrote its cf.storage (kept in the check, never saved). */
  stored: () => void;
  /** The frame hands the check a way to ping its document; returns the detach. */
  attach: (ping: (seq: number) => void) => () => void;
}

/** A frame script's `cf:script-error` (internal/preview/frame.js) as a problem; null for any other message. */
export function scriptErrorOf(data: unknown): Omit<CheckProblem, "count"> | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; kind?: unknown; message?: unknown; where?: unknown };
  if (m.type !== "cf:script-error" || typeof m.message !== "string") return null;
  const kind = m.kind === "rejection" || m.kind === "loader" || m.kind === "resource" ? m.kind : "script";
  return { kind, call: "", code: "", message: m.message, where: typeof m.where === "string" ? m.where : "" };
}

/** A call the page's bridge refused itself, before it reached the app (`cf:refused`, internal/bridge/bridge.js), as a problem; null for any other message. */
export function pageRefusalOf(data: unknown): Omit<CheckProblem, "count"> | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; call?: unknown; code?: unknown; message?: unknown };
  if (m.type !== "cf:refused" || typeof m.call !== "string" || typeof m.message !== "string") return null;
  return { kind: "bridge", call: m.call, code: typeof m.code === "string" ? m.code : "", message: m.message, where: "" };
}

/** The loader's end (`cf:loader`), or a `cf:here` answer's shape and seq; null for any other message. */
export function frameShapeOf(data: unknown): (FrameShape & { seq?: number }) | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; state?: unknown; seq?: unknown; height?: unknown; loader?: unknown };
  if (m.type === "cf:loader") return typeof m.state === "string" ? { loader: m.state } : null;
  if (m.type !== "cf:here") return null;
  return {
    ...(typeof m.seq === "number" ? { seq: m.seq } : {}),
    ...(typeof m.height === "number" && Number.isFinite(m.height) ? { height: m.height } : {}),
    ...(typeof m.loader === "string" ? { loader: m.loader } : {}),
  };
}

/** What a check needs from outside: the clock, a timer, and where the report goes. */
export interface PageCheckDeps {
  now: () => number;
  /** Runs fn after ms; returns the cancel. */
  later: (fn: () => void, ms: number) => () => void;
  /** The most to wait for the page to settle. */
  settleMs: number;
  /** The tallest card frame the window can draw. */
  maxHeight: number;
  /** The card frame's height changed (the page asked for another). */
  onHeight?: (height: number) => void;
  /** The report, once. */
  onDone: (r: PageCheckReport) => void;
}

/** One page check: the tap the frame feeds, and the clock that ends it. */
export class PageCheck implements PageCheckTap {
  private readonly deps: PageCheckDeps;
  private t0 = 0;
  private last = 0;
  private sawLoad = false;
  private answered = false;
  private loader = "";
  private asked: number | null = null;
  private pageHeight = 0;
  private inFlight = 0;
  private writes = 0;
  private calls = 0;
  private readonly problems = new Map<string, CheckProblem>();
  private ping: ((seq: number) => void) | null = null;
  private seq = PING_BASE;
  /** The last ping's seq and whether it was answered, while one is out. */
  private pinging: { seq: number; at: number; answered: boolean } | null = null;
  private stopTick: () => void = () => undefined;
  private started = false;
  private done = false;

  constructor(deps: PageCheckDeps) {
    this.deps = deps;
  }

  /** Starts the clock: from now the page has settleMs. Once only. */
  start(): void {
    if (this.started || this.done) return;
    this.started = true;
    this.t0 = this.last = this.deps.now();
    this.tick();
  }

  /** The card frame's height now: what the page asked for, else the card's default, within the window. */
  height(): number {
    return Math.min(this.deps.maxHeight, Math.max(MIN_HEIGHT, Math.ceil(this.asked ?? DEFAULT_HEIGHT)));
  }

  /** Ends the check at once with why there is no render (the page's grant failed). */
  fail(reason: string): void {
    this.finish(false, reason);
  }

  /** Stops the clock without a report (the check was replaced). */
  stop(): void {
    this.done = true;
    this.stopTick();
  }

  loaded(): void {
    this.sawLoad = true;
    this.touch();
  }

  note(n: FrameShape & { seq?: number }): void {
    if (n.loader !== undefined) this.loader = n.loader;
    if (n.height !== undefined) this.pageHeight = n.height;
    if (n.seq === undefined) {
      // The loader's end: something happened.
      this.touch();
      return;
    }
    this.answered = true;
    const p = this.pinging;
    if (p && n.seq === p.seq) p.answered = true;
  }

  resize(height: number): void {
    const before = this.height();
    this.asked = height;
    this.touch();
    const now = this.height();
    if (now !== before) this.deps.onHeight?.(now);
  }

  problem(p: Omit<CheckProblem, "count">): void {
    this.touch();
    const key = [p.kind, p.call, p.code, p.message, p.where].join("\u0000");
    const had = this.problems.get(key);
    if (had) had.count++;
    else if (this.problems.size < CHECK_PROBLEMS_MAX) this.problems.set(key, { ...p, count: 1 });
  }

  busy(delta: 1 | -1): void {
    this.inFlight = Math.max(0, this.inFlight + delta);
    this.touch();
  }

  call(): void {
    this.calls++;
    this.touch();
  }

  stored(): void {
    this.writes++;
    this.touch();
  }

  attach(ping: (seq: number) => void): () => void {
    this.ping = ping;
    return () => {
      if (this.ping === ping) this.ping = null;
    };
  }

  private touch(): void {
    this.last = this.deps.now();
  }

  /** Whether the page looks settled now. */
  private quiet(now: number): boolean {
    return this.sawLoad && this.answered && this.loader !== "running" && this.inFlight === 0 && now - this.last >= CHECK_QUIET_MS;
  }

  private tick(): void {
    if (this.done) return;
    const now = this.deps.now();
    const out = now - this.t0 >= this.deps.settleMs;
    const p = this.pinging;
    if (p) {
      // The last ping: answered with nothing new since, or out of time, the report goes.
      const waited = now - p.at >= CHECK_ANSWER_MS;
      if ((p.answered || waited) && (out || this.last <= p.at)) {
        this.finish(!out);
        return;
      }
      if (p.answered || waited) this.pinging = null;
    } else if (out || this.quiet(now)) {
      this.pinging = { seq: ++this.seq, at: now, answered: false };
      this.ping?.(this.seq);
    }
    this.stopTick = this.deps.later(() => {
      this.tick();
    }, CHECK_TICK_MS);
  }

  private finish(settled: boolean, failure = ""): void {
    if (this.done) return;
    this.done = true;
    this.stopTick();
    const now = this.deps.now();
    this.deps.onDone({
      loaded: failure === "" && this.answered,
      loader: this.loader,
      problems: [...this.problems.values()],
      height: this.height(),
      pageHeight: Math.ceil(this.pageHeight),
      resized: this.asked !== null,
      settleMs: Math.round(settled ? Math.max(0, this.last - this.t0) : Math.min(now - this.t0, this.deps.settleMs)),
      settled,
      busy: this.inFlight,
      storageWrites: this.writes,
      calls: this.calls,
      failure,
      shotError: "",
    });
  }
}
