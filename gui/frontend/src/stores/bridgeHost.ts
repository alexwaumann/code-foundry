/**
 * The host side of the bridge (docs/notes/bridge-2-gui.md): one per mounted HtmlFrame. A
 * page shown in a thread asks through `/cf/bridge.js`; this answers. `cf:run` becomes
 * CommandService.Invoke with the context and args the CLI inside the owning thread would
 * send (pageContext, fillPageArgs); `cf:on` forwards one of the GUI's own slices (stores/bridgeSources.ts),
 * so a page never talks to the API and never opens a stream. The message shapes are
 * lib/bridge.ts's.
 *
 * The frame (HtmlFrame) hands on only messages from its own window, at its origin, with its
 * nonce (docs/notes/bridge-fix-frames.md); `cf:ready` answers `cf:hello` and nothing else.
 *
 * Every new document in the frame starts over: its predecessor's calls are aborted, its
 * subscriptions stop, a confirmation it opened is cancelled and answers still on their way
 * to it are dropped. A document says hello as its script starts and bye as it goes
 * (pagehide); a load with no hello since the one before is a document without the script
 * (a link followed elsewhere) and starts over too. dispose (the frame unmounts) does the
 * same for good. A frame with no owning thread (a File tab on an arbitrary HTML file) gets
 * a ready with no thread, no verbs and no sources, and every call refused.
 *
 * Limits (BRIDGE_LIMITS): BRIDGE_LIMITS.runs runs in flight and BRIDGE_LIMITS.subscriptions
 * subscriptions per document, a run id unique among the runs in flight; past them a call
 * is refused `invalid`. A page that gives up on a run (`cf:cancel`) aborts its Invoke, so a
 * daemon-side wait (thread.wait, action.wait) ends with it.
 *
 * A verb that is not read-only runs only while the user is in the frame
 * (BridgeFrame.userPresent), whatever the page's script checked: past that it answers
 * `gesture`. A run that has to ask the user tells the page (`cf:pending`) as its question
 * is queued, so the page's clock stops until the answer (`cf:resume`); a page that gives up
 * (`cf:cancel`), or goes, takes its question with it, declined, and the command never runs.
 * A question is guarded (stores/confirm.ts). A frame has one open at a time. A question the
 * user did not say yes to (a no, a dismiss, the page giving up) holds the next back
 * PAGE_ASKS.gapMs, and PAGE_ASKS.perMinute of those in a minute hold it back until the
 * oldest is a minute old: past those a call is refused `invalid`, with the seconds to wait.
 * A yes holds nothing back. These last across its documents.
 *
 * A `cf:fetch` (docs/notes/bridge-fetch.md) goes to ThreadService.ProxyFetch under the
 * page's thread: the daemon makes the request, so the API's CORS rules do not apply. It
 * counts with the runs, `cf:cancel` and a new document abort it, and only its `invalid`,
 * `failed` and `timeout` answers reach the error strip.
 *
 * A run that saved a file (file.export) is shown to the user too, with a way to the file
 * (stores/pageSaved.ts); every other answer goes to the page only.
 *
 * Page storage (docs/notes/bridge-fix-storage.md): `cf:ready` carries the stored map and
 * every `cf:store` goes to the daemon (ThreadService.SetPageStorage for a thread's page,
 * PageService.SetPageStorage for a page alone), one at a time per thread (or page file) in
 * the order sent; every other frame of that thread (or file) hears the map after.
 */
import { listCommands, type CommandView, type UiContextView } from "@/api/command";
import { bridgeErrorOf } from "@/api/bridge";
import { getPageFileStorage, proxyPageFetch, setPageFileStorage } from "@/api/page";
import { getPageStorage, setPageStorage, type PageStorageValues } from "@/api/pageStorage";
import { proxyFetch, type ProxyFetchAnswer, type ProxyFetchCall } from "@/api/proxyFetch";
import {
  BRIDGE_LIMITS,
  errorResult,
  fetchCall,
  fetchResult,
  fillPageArgs,
  isBridgeSource,
  jsonSafe,
  needsThread,
  NO_THREAD,
  NOT_ALLOWED,
  okResult,
  parsePageMessage,
  readyMessage,
  type AskingMessage,
  type BridgeError,
  type BridgeErrorCode,
  type CallId,
  type EventMessage,
  type PageMessage,
  type PendingMessage,
  type ReadyMessage,
  type ResultMessage,
  type ResumeMessage,
  type StorageMessage,
} from "@/lib/bridge";
import { REPORTED_CODES, type PageError } from "@/lib/pageErrors";
import { tildify } from "@/lib/path";
import { Code, ConnectError } from "@connectrpc/connect";
import { CommandFailedSchema } from "@/gen/codefoundry/v1/command_pb";
import { publishedTheme } from "@/lib/theme";
import { bridgeSources } from "./bridgeSources";
import { invokeConfirmed } from "./commands";
import { requestConfirm, withdrawConfirm, type ConfirmRequest } from "./confirm";
import { isAbort } from "@/api/stream";
import { emptyContext } from "./context";
import { noticePageResult } from "./pageSaved";
import { useThreadsStore } from "./threads";

declare global {
  interface Window {
    /**
     * Dev/test hook (dev builds only): the live hosts, their subscriptions and every post
     * so far, so e2e can see a closed card's frame let go of everything.
     */
    __cfBridge?: { hosts: number; subscriptions: number; posts: number };
  }
}

/** The dev hook's counters; null in a production build. */
const dev = import.meta.env.DEV ? (window.__cfBridge ??= { hosts: 0, subscriptions: 0, posts: 0 }) : null;

/** How long a subscription gathers a burst of changes before it posts. */
export const BRIDGE_DEBOUNCE_MS = 50;

/**
 * How often a frame may ask the user after questions it got no yes to: the gap after one,
 * and how many in a minute before it waits for the oldest to age out. A yes holds nothing
 * back, so a page's second button works right after the first one's yes; the dialog's own
 * guards (ConfirmDialog) keep the press that gave that yes from answering the next.
 */
export const PAGE_ASKS = { gapMs: 5000, perMinute: 3 };

/** The longest name a question quotes. */
const QUOTED_NAME_CHARS = 80;

/** A name the page can choose, quoted and short, so it cannot pass for the dialog's own words. */
function quotedName(name: string): string {
  return JSON.stringify(name.length > QUOTED_NAME_CHARS ? `${name.slice(0, QUOTED_NAME_CHARS)}…` : name);
}

/**
 * What a page's call runs in: its thread and nothing else, which is what the CLI inside
 * that thread sends (UiContext.active_view's proto comment; docs/notes/bridge-1-daemon.md),
 * and the origin that tells the two apart (docs/notes/settings-user-only.md). The page
 * cannot change it: the host builds this. A verb on a worktree or terminal takes it in its
 * args, as from the CLI.
 */
export function pageContext(threadId: string): UiContextView {
  // "" for a page no thread owns: the context of the CLI outside any thread.
  return { ...emptyContext, activeView: "", activeThreadId: threadId, origin: "page" };
}

/** The codes of a fetch's answer the strip reports: not `unavailable` (no bridge, which the page shows itself). */
const FETCH_REPORTED: ReadonlySet<BridgeErrorCode> = new Set(["invalid", "failed", "timeout"]);

export type HostMessage = ReadyMessage | AskingMessage | ResultMessage | EventMessage | PendingMessage | ResumeMessage | StorageMessage;

/**
 * Each storage's calls (a thread's, `thread:<id>`, or a page file's, `page:<path>`),
 * chained so the daemon sees writes and reads in the order sent.
 */
const storageChains = new Map<string, Promise<unknown>>();
/** The live hosts of each storage, told the storage after another one wrote. */
const storageFrames = new Map<string, Set<(values: PageStorageValues) => void>>();

function onStorageChain<T>(key: string, call: () => Promise<T>): Promise<T> {
  const next = (storageChains.get(key) ?? Promise.resolve()).then(call);
  const tail = next.catch(() => undefined);
  storageChains.set(key, tail);
  void tail.then(() => {
    if (storageChains.get(key) === tail) storageChains.delete(key);
  });
  return next;
}

/**
 * What a frame with no thread may do (docs/notes/page-ownership-gui.md): `allowed`, the
 * bridge without a thread, for the page at its resolved `path` (PageAccess.path); `ask`,
 * nothing until the user answers (its ready held); `refused`, nothing, every call refused
 * with `error`.
 */
export type PageBridge = { kind: "allowed"; path: string } | { kind: "ask" } | { kind: "refused"; error: BridgeError };

/** Whom a host acts for now. */
/** `quiet`: its refusals are the user's own answer (or no page at all), which the footer shows: not reported to the error strip. */
type Mode = { kind: "thread"; id: string } | { kind: "page"; path: string } | { kind: "ask" } | { kind: "none"; error: BridgeError; quiet: boolean };

function modeOf(threadId: string | null, page: PageBridge | undefined): Mode {
  if (threadId !== null) return { kind: "thread", id: threadId };
  if (!page) return { kind: "none", error: NO_THREAD, quiet: false };
  if (page.kind === "allowed") return { kind: "page", path: page.path };
  if (page.kind === "ask") return { kind: "ask" };
  return { kind: "none", error: page.error, quiet: true };
}

function sameMode(a: Mode, b: Mode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "thread" && b.kind === "thread") return a.id === b.id;
  if (a.kind === "page" && b.kind === "page") return a.path === b.path;
  if (a.kind === "none" && b.kind === "none") return a.error.message === b.error.message;
  return true;
}

/** The storage a mode reads and writes, or null for none. */
function storageKey(m: Mode): string | null {
  if (m.kind === "thread") return `thread:${m.id}`;
  if (m.kind === "page") return `page:${m.path}`;
  return null;
}

/**
 * A PageService error as a page alone sees it: the daemon's consent refusals (the answer
 * changed elsewhere since this frame was told) say the user has not allowed the page;
 * anything else as a thread's (bridgeErrorOf).
 */
function pageErrorOf(err: unknown): BridgeError {
  if (err instanceof ConnectError && (err.code === Code.PermissionDenied || (err.code === Code.FailedPrecondition && err.findDetails(CommandFailedSchema).length === 0))) {
    return NOT_ALLOWED;
  }
  return bridgeErrorOf(err);
}

/** The daemon's refusal of a verb whose thread arg defaults to the caller's thread, which a page alone has not got. */
const NO_ACTIVE_THREAD = "(default: the active thread; there is none)";

/** No code: the refusals the error strip does not show. */
const QUIET: ReadonlySet<BridgeErrorCode> = new Set();

/** How many calls a document may make while its ready is held; past them each is refused. */
const HELD_MAX = 64;

export interface BridgeHost {
  /** The frame fired load: a document without the script, unless it said hello since the last load, starts over. */
  loaded: () => void;
  /** A message from the frame's own window (the caller checked `event.source`, origin and nonce). */
  receive: (data: unknown) => void;
  /**
   * What a frame with no thread may do now (the user answered, or the grant was read
   * again). A held ready goes out under the new access, and the calls held with it run.
   * True when a document that already had its ready under the old access is in the frame:
   * its calls were stopped, and the frame should load it again so it starts under the new.
   */
  setPage: (page: PageBridge) => boolean;
  /** The frame unmounts: stop everything. */
  dispose: () => void;
}

export interface BridgeFrame {
  /** The owning thread; null when the page has none (`page` then says what it may do). */
  threadId: string | null;
  /** What a page with no thread may do at first (setPage changes it); absent: nothing, refused with NO_THREAD (a daemon older than page ownership). */
  page?: PageBridge;
  /** The page's file name, quoted under "Asked by" in a confirmation. */
  pageName: string;
  /** The page's file, named under "Asked by" for a page with no thread; "" when not known. */
  pagePath?: string;
  /** Whether the user is in this frame now (lib/frameAttention.ts). */
  userPresent: () => boolean;
  /** Posts to the frame's window. */
  post: (msg: HostMessage) => void;
  /**
   * Hears each error the page is answered with whose code the strip reports
   * (lib/pageErrors.ts REPORTED_CODES), for the current document only.
   */
  onError?: (e: Omit<PageError, "count">) => void;
  /** A document said hello while the page is `ask`: it wants Code Foundry, so the user is asked. */
  onAsk?: () => void;
}

export function createBridgeHost(frame: BridgeFrame): BridgeHost {
  const { threadId } = frame;
  let mode: Mode = modeOf(threadId, frame.page);
  /** The document now in the frame; a reply for an older one is dropped. */
  let doc = 0;
  let disposed = false;
  const subs = new Map<CallId, () => void>();
  let commands: Promise<readonly CommandView[]> | null = null;
  /** The frame's questions, in all its documents: whether one is open, and when each one that
   * ended without a yes in the last minute ended (PAGE_ASKS holds the next back by those). */
  const asks = { open: false, unanswered: [] as number[] };
  /** The runs whose question is open or queued, by call id: cancel declines it. */
  const asking = new Map<CallId, { cancelled: boolean; req: ConfirmRequest }>();
  /** The document's runs in flight, by call id: cancel and a new document abort them. */
  const running = new Map<CallId, AbortController>();
  /** Whether a document said hello since the frame's last load. */
  let greeted = false;
  /** The document that last said hello (doc's value then): it is still in the frame while equal. */
  let helloDoc = -1;
  /** Whether the document now in the frame waits for its ready (`ask`), and the calls it made meanwhile. */
  let heldReady = false;
  let held: PageMessage[] = [];
  const hearStorage = (values: PageStorageValues) => {
    post(doc, { type: "cf:storage", values });
  };
  /** The storage this host hears other frames' writes to, or null. */
  let joined: string | null = null;
  const joinStorage = () => {
    const key = storageKey(mode);
    if (key === joined) return;
    leaveStorage();
    if (key === null) return;
    let frames = storageFrames.get(key);
    if (!frames) storageFrames.set(key, (frames = new Set()));
    frames.add(hearStorage);
    joined = key;
  };
  const leaveStorage = () => {
    if (joined === null) return;
    const frames = storageFrames.get(joined);
    frames?.delete(hearStorage);
    if (frames?.size === 0) storageFrames.delete(joined);
    joined = null;
  };
  joinStorage();

  const post = (forDoc: number, msg: HostMessage) => {
    if (disposed || forDoc !== doc) return;
    if (dev) dev.posts++;
    frame.post(msg);
  };
  if (dev) dev.hosts++;

  /** Answers a call with an error, and reports it when the strip shows such errors. */
  const fail = (
    forDoc: number,
    id: CallId,
    call: string,
    error: BridgeError,
    declined?: { message: string; resultJson: string } | null,
    reported: ReadonlySet<BridgeErrorCode> = REPORTED_CODES,
  ) => {
    if (disposed || forDoc !== doc) return;
    post(forDoc, errorResult(id, error, declined));
    if (reported.has(error.code)) frame.onError?.({ call, code: error.code, message: error.message, atMs: Date.now() });
  };

  /** Why the page may make no call now, or null when it may. */
  const noBridge = (): BridgeError | null => {
    if (mode.kind === "none") return mode.error;
    if (mode.kind === "ask") return NOT_ALLOWED;
    return null;
  };
  /** The codes of a no-bridge refusal the strip reports: none for a page the user refused or no page. */
  const noBridgeReported = (codes: ReadonlySet<BridgeErrorCode> = REPORTED_CODES): ReadonlySet<BridgeErrorCode> => (mode.kind === "none" && mode.quiet ? QUIET : codes);

  /** The thread the page's calls run in: its own, or "" for a page alone. */
  const contextThread = (): string => (mode.kind === "thread" ? mode.id : "");

  const listed = (): Promise<readonly CommandView[]> => {
    if (mode.kind === "none" || mode.kind === "ask") return Promise.resolve([]);
    const id = contextThread();
    commands ??= Promise.resolve()
      .then(() => listCommands(pageContext(id), { includeUnavailable: true }))
      .catch((err: unknown) => {
      // Asked again by the next ready or run.
      commands = null;
      throw err;
    });
    return commands;
  };

  const readStorage = (m: Mode): Promise<PageStorageValues> => {
    const key = storageKey(m);
    if (key === null) return Promise.resolve({});
    return onStorageChain(key, () => (m.kind === "thread" ? getPageStorage(m.id) : m.kind === "page" ? getPageFileStorage(m.path) : Promise.resolve({})));
  };

  const ready = (forDoc: number) => {
    const m = mode;
    if (m.kind === "ask") {
      heldReady = true;
      post(forDoc, { type: "cf:asking", cf: 1 });
      frame.onAsk?.();
      return;
    }
    if (m.kind === "none") {
      post(forDoc, readyMessage({ kind: "none", refusal: m.error.message }, publishedTheme(), []));
      return;
    }
    const access = m.kind === "thread" ? { kind: "thread" as const, thread: { id: m.id, name: useThreadsStore.getState().byId[m.id]?.name ?? "" } } : { kind: "page" as const };
    const verbs = listed().then(
      (cmds) => cmds.filter((c) => c.readOnly).map((c) => c.name),
      () => [],
    );
    // A storage the daemon cannot read now reads as empty; a write still goes through.
    const storage = readStorage(m).catch(() => ({}));
    void Promise.all([verbs, storage]).then(([readOnly, values]) => {
      post(forDoc, readyMessage(access, publishedTheme(), readOnly, values));
    });
  };

  const store = (forDoc: number, id: CallId, key: string, value: string | null) => {
    const m = mode;
    const sk = storageKey(m);
    if (sk === null) {
      post(forDoc, errorResult(id, noBridge() ?? NO_THREAD));
      return;
    }
    const write = () => (m.kind === "thread" ? setPageStorage(m.id, key, value) : m.kind === "page" ? setPageFileStorage(m.path, key, value) : Promise.resolve({}));
    void onStorageChain(sk, write).then(
      (values) => {
        post(forDoc, okResult(id, { message: "", resultJson: "" }));
        for (const hear of storageFrames.get(sk) ?? []) if (hear !== hearStorage) hear(values);
      },
      async (err: unknown) => {
        post(forDoc, errorResult(id, m.kind === "page" ? pageErrorOf(err) : bridgeErrorOf(err)));
        // The page applied the write already: put back what is stored.
        const values = await readStorage(m).catch(() => null);
        if (values) post(forDoc, { type: "cf:storage", values });
      },
    );
  };

  /** Aborts the document's runs, stops its subscriptions and takes back its questions. */
  const stopAll = () => {
    for (const c of running.values()) c.abort();
    running.clear();
    for (const stop of subs.values()) stop();
    if (dev) dev.subscriptions -= subs.size;
    subs.clear();
    for (const call of asking.values()) withdrawConfirm(call.req);
    asking.clear();
  };

  /** A page gave up on a run: its Invoke is aborted, and its question, open or queued, declined. */
  const cancel = (id: CallId) => {
    running.get(id)?.abort();
    const call = asking.get(id);
    if (!call) return;
    call.cancelled = true;
    withdrawConfirm(call.req);
  };

  /** Why this frame may not open a new question now, or null. */
  const askRefusal = (): string | null => {
    const now = Date.now();
    const noes = (asks.unanswered = asks.unanswered.filter((at) => now - at < 60_000));
    if (asks.open) return "this page already has a question open; wait for the answer";
    const last = noes.at(-1);
    const capped = noes.length >= PAGE_ASKS.perMinute ? noes[noes.length - PAGE_ASKS.perMinute] : undefined;
    const wait = Math.max(last === undefined ? 0 : last + PAGE_ASKS.gapMs - now, capped === undefined ? 0 : capped + 60_000 - now);
    if (wait > 0) return `this page is asking too often; ask again in ${String(Math.ceil(wait / 1000))} s`;
    return null;
  };

  /** Puts a question to the user: the answer, a no if the page gave up on it first. */
  const question = async (forDoc: number, id: CallId, req: ConfirmRequest): Promise<boolean> => {
    const call = { cancelled: false, req };
    asking.set(id, call);
    asks.open = true;
    post(forDoc, { type: "cf:pending", id, reason: "confirm" });
    let yes = false;
    try {
      yes = (await requestConfirm(req)) && !call.cancelled;
      return yes;
    } finally {
      asks.open = false;
      // Only a question the user did not say yes to is the spam the gap and the cap are for.
      if (!yes) asks.unanswered.push(Date.now());
      if (asking.get(id) === call) asking.delete(id);
    }
  };

  /** Why a call in flight cannot start now (a duplicate id, past the cap), or null. */
  const refusal = (id: CallId): BridgeError | null => {
    if (running.has(id)) return { code: "invalid", message: `a call with id ${String(id)} is already running` };
    if (running.size >= BRIDGE_LIMITS.runs) return { code: "invalid", message: `too many calls at once (${String(BRIDGE_LIMITS.runs)}); wait for one to finish` };
    return null;
  };

  /** Who asks, under the confirmation's "Asked by": the page and its thread, or the page's file when it has none. */
  const callerDetail = (): string => {
    const page = `Page ${quotedName(frame.pageName)}`;
    if (mode.kind === "thread") {
      const id = mode.id;
      return `${page} in thread ${quotedName(useThreadsStore.getState().byId[id]?.name || id)}`;
    }
    return frame.pagePath ? `${page} at ${tildify(frame.pagePath)}, in no thread` : `${page}, in no thread`;
  };

  const run = async (forDoc: number, id: CallId, verb: string, args: Record<string, string>, present: boolean) => {
    const none = noBridge();
    if (none) {
      fail(forDoc, id, verb, none, null, noBridgeReported());
      return;
    }
    const tid = contextThread();
    const refused = refusal(id);
    if (refused) {
      fail(forDoc, id, verb, refused);
      return;
    }
    const abort = new AbortController();
    running.set(id, abort);
    const asked = { declined: false, refused: null as BridgeError | null, started: false };
    try {
      const spec = await listed().then(
        (cmds) => cmds.find((c) => c.name === verb),
        () => undefined,
      );
      if (!present && !spec?.readOnly) {
        fail(forDoc, id, verb, { code: "gesture", message: `${verb} changes something, so it runs only from a click or key press in the page` });
        return;
      }
      const cwd = tid ? (useThreadsStore.getState().byId[tid]?.worktreePath ?? "") : "";
      const callArgs = spec ? fillPageArgs(args, spec.args, { threadId: tid, cwd }) : args;
      if (abort.signal.aborted) return;
      const res = await invokeConfirmed(verb, callArgs, pageContext(tid), undefined, {
        signal: abort.signal,
        ask: async (req) => {
          // A later stage of a run is the same question going on, not a new one.
          const why = asked.started ? null : askRefusal();
          if (why !== null) {
            asked.refused = { code: "invalid", message: why };
            return false;
          }
          asked.started = true;
          const yes = await question(forDoc, id, { ...req, guarded: true, caller: "a page", callerDetail: callerDetail() });
          if (!yes) asked.declined = true;
          else post(forDoc, { type: "cf:resume", id });
          return yes;
        },
      });
      if (asked.refused) fail(forDoc, id, verb, asked.refused);
      else if (asked.declined) fail(forDoc, id, verb, { code: "declined", message: "the user declined" }, res);
      else {
        post(forDoc, okResult(id, res ?? { message: "", resultJson: "" }));
        // The saved file's notice opens it in the thread's panel: a page alone has none.
        if (tid) noticePageResult(tid, verb, res);
      }
    } catch (err) {
      // An aborted call's page gave up on it, or is gone: nobody to answer.
      if (abort.signal.aborted && isAbort(err)) return;
      const e = bridgeErrorOf(err);
      // A verb that acts on the caller's thread by default, from a page that has none.
      if (!tid && e.message.includes(NO_ACTIVE_THREAD)) fail(forDoc, id, verb, { code: "unavailable", message: `${needsThread(verb).message} unless its args name the thread: ${e.message}` });
      else fail(forDoc, id, verb, e);
    } finally {
      if (running.get(id) === abort) running.delete(id);
    }
  };

  const fetch = async (forDoc: number, m: Extract<PageMessage, { kind: "fetch" }>) => {
    const call = fetchCall(m.url);
    const none = noBridge();
    if (none) {
      fail(forDoc, m.id, call, none, null, noBridgeReported(FETCH_REPORTED));
      return;
    }
    const refused = refusal(m.id);
    if (refused) {
      fail(forDoc, m.id, call, refused, null, FETCH_REPORTED);
      return;
    }
    const abort = new AbortController();
    running.set(m.id, abort);
    const at = mode;
    const req: ProxyFetchCall = { url: m.url, method: m.method, headers: m.headers, body: m.body, timeoutMs: m.timeout };
    try {
      let res: ProxyFetchAnswer;
      if (at.kind === "thread") res = await proxyFetch(at.id, req, { signal: abort.signal });
      else if (at.kind === "page") res = await proxyPageFetch(at.path, req, { signal: abort.signal });
      else throw new Error("unreachable");
      post(forDoc, fetchResult(m.id, res));
    } catch (err) {
      if (!(abort.signal.aborted && isAbort(err))) fail(forDoc, m.id, call, at.kind === "page" ? pageErrorOf(err) : bridgeErrorOf(err), null, FETCH_REPORTED);
    } finally {
      if (running.get(m.id) === abort) running.delete(m.id);
    }
  };

  const unsubscribe = (id: CallId) => {
    const stop = subs.get(id);
    if (!stop) return;
    stop();
    subs.delete(id);
    if (dev) dev.subscriptions--;
  };

  const on = (forDoc: number, id: CallId, source: string) => {
    const call = `cf.on("${source}")`;
    const none = noBridge();
    if (none) {
      fail(forDoc, id, call, none, null, noBridgeReported());
      return;
    }
    if (!isBridgeSource(source)) {
      fail(forDoc, id, call, { code: "invalid", message: `no source ${source}` });
      return;
    }
    // The page's own thread: a page alone has none to follow. Every other source is app-wide.
    const tid = contextThread();
    if (source === "thread" && !tid) {
      fail(forDoc, id, call, needsThread(call));
      return;
    }
    unsubscribe(id);
    if (subs.size >= BRIDGE_LIMITS.subscriptions) {
      fail(forDoc, id, call, { code: "invalid", message: `too many subscriptions (${String(BRIDGE_LIMITS.subscriptions)}); end one with cf.off first` });
      return;
    }
    const spec = bridgeSources[source];
    const why = spec.unavailable?.() ?? null;
    if (why !== null) {
      fail(forDoc, id, call, { code: "unavailable", message: why });
      return;
    }
    const send = (event: unknown) => {
      post(forDoc, { type: "cf:event", id, source, event: jsonSafe(event) });
    };
    let last: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queue: unknown[] = [];
    const flush = () => {
      timer = undefined;
      if (spec.snapshot) {
        const now = spec.snapshot(tid);
        if (now === undefined) return;
        const text = JSON.stringify(now);
        if (text === last) return;
        last = text;
        send(now);
        return;
      }
      for (const ev of queue.splice(0)) send(ev);
    };
    const stop = spec.subscribe(tid, (event) => {
      if (!spec.snapshot) queue.push(event);
      timer ??= setTimeout(flush, BRIDGE_DEBOUNCE_MS);
    });
    subs.set(id, () => {
      stop();
      clearTimeout(timer);
    });
    if (dev) dev.subscriptions++;
    // The state as it is now, before any change.
    if (spec.snapshot) flush();
  };

  /** The document now in the frame is a new one: drop everything the last one had. */
  const startOver = () => {
    doc++;
    stopAll();
    heldReady = false;
    held = [];
  };

  /** Acts on one call of the document now in the frame. */
  const dispatch = (m: Exclude<PageMessage, { kind: "hello" | "bye" }>) => {
    const forDoc = doc;
    switch (m.kind) {
      case "run":
        // Now, not after the await for the verb's spec.
        void run(forDoc, m.id, m.verb, m.args, frame.userPresent());
        return;
      case "on":
        on(forDoc, m.id, m.source);
        return;
      case "off":
        unsubscribe(m.id);
        return;
      case "store":
        store(forDoc, m.id, m.key, m.value);
        return;
      case "cancel":
        cancel(m.id);
        return;
      case "fetch":
        void fetch(forDoc, m);
        return;
      case "bad":
        fail(forDoc, m.id, m.call, { code: "invalid", message: m.message });
        return;
    }
  };

  return {
    loaded: () => {
      if (disposed) return;
      if (greeted) greeted = false;
      else startOver();
    },
    receive: (data) => {
      if (disposed) return;
      const m = parsePageMessage(data);
      if (!m) return;
      switch (m.kind) {
        case "hello":
          startOver();
          greeted = true;
          helloDoc = doc;
          ready(doc);
          return;
        case "bye":
          startOver();
          return;
      }
      if (heldReady) {
        // The user is still being asked: the call waits for the answer, within a bound.
        if (held.length < HELD_MAX) held.push(m);
        else if (m.kind !== "off" && m.kind !== "cancel") fail(doc, m.id, m.kind === "bad" ? m.call : m.kind, { code: "invalid", message: `too many calls while the user is asked about this page (${String(HELD_MAX)})` });
        return;
      }
      dispatch(m);
    },
    setPage: (page) => {
      if (disposed || threadId !== null) return false;
      const next = modeOf(null, page);
      if (sameMode(mode, next)) return false;
      mode = next;
      commands = null;
      joinStorage();
      if (heldReady) {
        if (next.kind === "ask") return false;
        // The answer came while the document waited: its ready, then its calls, in order.
        heldReady = false;
        const calls = held;
        held = [];
        ready(doc);
        for (const c of calls) dispatch(c as Exclude<PageMessage, { kind: "hello" | "bye" }>);
        return false;
      }
      // A document that already had its ready under the old access: stop it; the frame loads it again.
      const live = helloDoc === doc;
      stopAll();
      return live;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopAll();
      leaveStorage();
      if (dev) dev.hosts--;
    },
  };
}
