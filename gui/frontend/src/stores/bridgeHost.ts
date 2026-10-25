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
 * A run that has to ask the user tells the page (`cf:pending`) as its question is queued,
 * so the page's clock stops until the answer (`cf:resume`); a page that gives up
 * (`cf:cancel`), or goes, takes its question with it, declined, and the command never runs.
 *
 * Page storage (docs/notes/bridge-fix-storage.md): `cf:ready` carries the thread's stored
 * map and every `cf:store` goes to the daemon (ThreadService.SetPageStorage), one at a time
 * per thread in the order sent; every other frame of the thread hears the map after.
 */
import { listCommands, type CommandView, type UiContextView } from "@/api/command";
import { bridgeErrorOf } from "@/api/bridge";
import { getPageStorage, setPageStorage, type PageStorageValues } from "@/api/pageStorage";
import {
  BRIDGE_LIMITS,
  errorResult,
  fillPageArgs,
  isBridgeSource,
  jsonSafe,
  NO_THREAD,
  okResult,
  parsePageMessage,
  readyMessage,
  type BridgeError,
  type CallId,
  type EventMessage,
  type PendingMessage,
  type ReadyMessage,
  type ResultMessage,
  type ResumeMessage,
  type StorageMessage,
} from "@/lib/bridge";
import { REPORTED_CODES, type PageError } from "@/lib/pageErrors";
import { publishedTheme } from "@/lib/theme";
import { bridgeSources } from "./bridgeSources";
import { invokeConfirmed } from "./commands";
import { answerConfirm, useConfirmStore } from "./confirm";
import { isAbort } from "@/api/stream";
import { emptyContext } from "./context";
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
 * What a page's call runs in: its thread and nothing else, which is what the CLI inside
 * that thread sends (UiContext.active_view's proto comment; docs/notes/bridge-1-daemon.md).
 * A verb on a worktree or terminal takes it in its args, as from the CLI.
 */
export function pageContext(threadId: string): UiContextView {
  return { ...emptyContext, activeView: "", activeThreadId: threadId };
}

export type HostMessage = ReadyMessage | ResultMessage | EventMessage | PendingMessage | ResumeMessage | StorageMessage;

/** Each thread's page storage calls, chained so the daemon sees writes and reads in the order sent. */
const storageChains = new Map<string, Promise<unknown>>();
/** The live hosts of each thread, told the thread's storage after another one wrote. */
const storageFrames = new Map<string, Set<(values: PageStorageValues) => void>>();

function onStorageChain<T>(threadId: string, call: () => Promise<T>): Promise<T> {
  const next = (storageChains.get(threadId) ?? Promise.resolve()).then(call);
  const tail = next.catch(() => undefined);
  storageChains.set(threadId, tail);
  void tail.then(() => {
    if (storageChains.get(threadId) === tail) storageChains.delete(threadId);
  });
  return next;
}

export interface BridgeHost {
  /** The frame fired load: a document without the script, unless it said hello since the last load, starts over. */
  loaded: () => void;
  /** A message from the frame's own window (the caller checked `event.source`, origin and nonce). */
  receive: (data: unknown) => void;
  /** The frame unmounts: stop everything. */
  dispose: () => void;
}

export interface BridgeFrame {
  /** The owning thread; null when the page is not shown in one. */
  threadId: string | null;
  /** The page's file name, for "Asked by" in a confirmation. */
  pageName: string;
  /** Posts to the frame's window. */
  post: (msg: HostMessage) => void;
  /**
   * Hears each error the page is answered with whose code the strip reports
   * (lib/pageErrors.ts REPORTED_CODES), for the current document only.
   */
  onError?: (e: Omit<PageError, "count">) => void;
}

export function createBridgeHost(frame: BridgeFrame): BridgeHost {
  const { threadId } = frame;
  /** The document now in the frame; a reply for an older one is dropped. */
  let doc = 0;
  let disposed = false;
  const subs = new Map<CallId, () => void>();
  let commands: Promise<readonly CommandView[]> | null = null;
  /** Confirmations wait for the one before (one dialog per frame at a time). */
  let confirms: Promise<unknown> = Promise.resolve();
  /** The confirmation this frame has open, to cancel on dispose. */
  let open: unknown = null;
  /** The runs whose question is open or queued, by call id: cancel declines it. */
  const asking = new Map<CallId, { cancelled: boolean; dialog: unknown }>();
  /** The document's runs in flight, by call id: cancel and a new document abort them. */
  const running = new Map<CallId, AbortController>();
  /** Whether a document said hello since the frame's last load. */
  let greeted = false;
  const hearStorage = (values: PageStorageValues) => {
    post(doc, { type: "cf:storage", values });
  };
  if (threadId !== null) {
    let frames = storageFrames.get(threadId);
    if (!frames) storageFrames.set(threadId, (frames = new Set()));
    frames.add(hearStorage);
  }

  const post = (forDoc: number, msg: HostMessage) => {
    if (disposed || forDoc !== doc) return;
    if (dev) dev.posts++;
    frame.post(msg);
  };
  if (dev) dev.hosts++;

  /** Answers a call with an error, and reports it when the strip shows such errors. */
  const fail = (forDoc: number, id: CallId, call: string, error: BridgeError, declined?: { message: string; resultJson: string } | null) => {
    if (disposed || forDoc !== doc) return;
    post(forDoc, errorResult(id, error, declined));
    if (REPORTED_CODES.has(error.code)) frame.onError?.({ call, code: error.code, message: error.message, atMs: Date.now() });
  };

  const listed = (): Promise<readonly CommandView[]> => {
    if (threadId === null) return Promise.resolve([]);
    const id = threadId;
    commands ??= Promise.resolve()
      .then(() => listCommands(pageContext(id), { includeUnavailable: true }))
      .catch((err: unknown) => {
      // Asked again by the next ready or run.
      commands = null;
      throw err;
    });
    return commands;
  };

  const ready = (forDoc: number) => {
    const thread = threadId === null ? null : { id: threadId, name: useThreadsStore.getState().byId[threadId]?.name ?? "" };
    const verbs = listed().then(
      (cmds) => cmds.filter((c) => c.readOnly).map((c) => c.name),
      () => [],
    );
    const id = threadId;
    // A storage the daemon cannot read now reads as empty; a write still goes through.
    const storage = id === null ? Promise.resolve({}) : onStorageChain(id, () => getPageStorage(id)).catch(() => ({}));
    void Promise.all([verbs, storage]).then(([readOnly, values]) => {
      post(forDoc, readyMessage(thread, publishedTheme(), readOnly, values));
    });
  };

  const store = (forDoc: number, id: CallId, key: string, value: string | null) => {
    if (threadId === null) {
      post(forDoc, errorResult(id, NO_THREAD));
      return;
    }
    const tid = threadId;
    void onStorageChain(tid, () => setPageStorage(tid, key, value)).then(
      (values) => {
        post(forDoc, okResult(id, { message: "", resultJson: "" }));
        for (const hear of storageFrames.get(tid) ?? []) if (hear !== hearStorage) hear(values);
      },
      async (err: unknown) => {
        post(forDoc, errorResult(id, bridgeErrorOf(err)));
        // The page applied the write already: put back what is stored.
        const values = await onStorageChain(tid, () => getPageStorage(tid)).catch(() => null);
        if (values) post(forDoc, { type: "cf:storage", values });
      },
    );
  };

  /** Aborts the document's runs, stops its subscriptions and cancels a confirmation it has open. */
  const stopAll = () => {
    for (const c of running.values()) c.abort();
    running.clear();
    for (const stop of subs.values()) stop();
    if (dev) dev.subscriptions -= subs.size;
    subs.clear();
    if (open !== null && useConfirmStore.getState().pending === open) answerConfirm(false);
    open = null;
    asking.clear();
  };

  /** A page gave up on a run: its Invoke is aborted, and its question, open or queued, declined. */
  const cancel = (id: CallId) => {
    running.get(id)?.abort();
    const call = asking.get(id);
    if (!call) return;
    call.cancelled = true;
    if (call.dialog !== null && useConfirmStore.getState().pending === call.dialog) answerConfirm(false);
  };

  /**
   * Runs ask after this frame's earlier confirmations; never once its document is gone or
   * the page gave up on the call.
   */
  const queued = (forDoc: number, id: CallId, ask: () => Promise<boolean>): Promise<boolean> => {
    const call = { cancelled: false, dialog: null as unknown };
    asking.set(id, call);
    post(forDoc, { type: "cf:pending", id, reason: "confirm" });
    const next = confirms.then(async () => {
      if (disposed || forDoc !== doc || call.cancelled) return false;
      const answer = ask();
      // requestConfirm opens its dialog at once; a command's own presenter may not use it.
      const mine = useConfirmStore.getState().pending;
      open = mine;
      call.dialog = mine;
      try {
        const yes = await answer;
        return yes && !call.cancelled;
      } finally {
        if (open === mine) open = null;
        if (asking.get(id) === call) asking.delete(id);
      }
    });
    confirms = next.catch(() => undefined);
    return next;
  };

  const run = async (forDoc: number, id: CallId, verb: string, args: Record<string, string>) => {
    if (threadId === null) {
      fail(forDoc, id, verb, NO_THREAD);
      return;
    }
    if (running.has(id)) {
      fail(forDoc, id, verb, { code: "invalid", message: `a call with id ${String(id)} is already running` });
      return;
    }
    if (running.size >= BRIDGE_LIMITS.runs) {
      fail(forDoc, id, verb, { code: "invalid", message: `too many calls at once (${String(BRIDGE_LIMITS.runs)}); wait for one to finish` });
      return;
    }
    const abort = new AbortController();
    running.set(id, abort);
    const asked = { declined: false };
    try {
      const spec = await listed().then(
        (cmds) => cmds.find((c) => c.name === verb),
        () => undefined,
      );
      const cwd = useThreadsStore.getState().byId[threadId]?.worktreePath ?? "";
      const callArgs = spec ? fillPageArgs(args, spec.args, { threadId, cwd }) : args;
      if (abort.signal.aborted) return;
      const res = await invokeConfirmed(verb, callArgs, pageContext(threadId), `${frame.pageName}, a page in ${useThreadsStore.getState().byId[threadId]?.name || threadId}`, {
        signal: abort.signal,
        around: async (ask) => {
          const yes = await queued(forDoc, id, ask);
          if (!yes) asked.declined = true;
          else post(forDoc, { type: "cf:resume", id });
          return yes;
        },
      });
      if (asked.declined) fail(forDoc, id, verb, { code: "declined", message: "the user declined" }, res);
      else post(forDoc, okResult(id, res ?? { message: "", resultJson: "" }));
    } catch (err) {
      // An aborted call's page gave up on it, or is gone: nobody to answer.
      if (!(abort.signal.aborted && isAbort(err))) fail(forDoc, id, verb, bridgeErrorOf(err));
    } finally {
      if (running.get(id) === abort) running.delete(id);
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
    if (threadId === null) {
      fail(forDoc, id, call, NO_THREAD);
      return;
    }
    if (!isBridgeSource(source)) {
      fail(forDoc, id, call, { code: "invalid", message: `no source ${source}` });
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
        const now = spec.snapshot(threadId);
        if (now === undefined) return;
        const text = JSON.stringify(now);
        if (text === last) return;
        last = text;
        send(now);
        return;
      }
      for (const ev of queue.splice(0)) send(ev);
    };
    const stop = spec.subscribe(threadId, (event) => {
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
          ready(doc);
          return;
        case "bye":
          startOver();
          return;
      }
      const forDoc = doc;
      switch (m.kind) {
        case "run":
          void run(forDoc, m.id, m.verb, m.args);
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
        case "bad":
          fail(forDoc, m.id, m.call, { code: "invalid", message: m.message });
          return;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopAll();
      if (threadId !== null) {
        const frames = storageFrames.get(threadId);
        frames?.delete(hearStorage);
        if (frames?.size === 0) storageFrames.delete(threadId);
      }
      if (dev) dev.hosts--;
    },
  };
}
