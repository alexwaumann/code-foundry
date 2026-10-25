/**
 * The host side of the bridge (docs/notes/bridge-2-gui.md): one per mounted HtmlFrame. A
 * page shown in a thread asks through `/cf/bridge.js`; this answers. `cf:run` becomes
 * CommandService.Invoke with the context and args the CLI inside the owning thread would
 * send (pageContext, fillPageArgs); `cf:on` forwards one of the GUI's own slices (stores/bridgeSources.ts),
 * so a page never talks to the API and never opens a stream. The message shapes are
 * lib/bridge.ts's.
 *
 * Every new document in the frame (a load: a reload, an in-frame navigation) starts over:
 * its predecessor's subscriptions stop, a confirmation it opened is cancelled and answers
 * still on their way to it are dropped. dispose (the frame unmounts) does the same for good. A frame with no owning thread (a File tab on an arbitrary HTML file) gets a
 * ready with no thread, no verbs and no sources, and every call refused.
 */
import { listCommands, type CommandView, type UiContextView } from "@/api/command";
import { bridgeErrorOf } from "@/api/bridge";
import {
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
  type ReadyMessage,
  type ResultMessage,
} from "@/lib/bridge";
import { REPORTED_CODES, type PageError } from "@/lib/pageErrors";
import { publishedTheme } from "@/lib/theme";
import { bridgeSources } from "./bridgeSources";
import { invokeConfirmed } from "./commands";
import { answerConfirm, useConfirmStore } from "./confirm";
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

export type HostMessage = ReadyMessage | ResultMessage | EventMessage;

export interface BridgeHost {
  /** A new document loaded in the frame: forget the last one's calls and subscriptions, and say ready. */
  loaded: () => void;
  /** A message from the frame's own window (the caller checked `event.source` and origin). */
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
    const send = (cmds: readonly CommandView[]) => {
      post(forDoc, readyMessage(thread, publishedTheme(), cmds.filter((c) => c.readOnly).map((c) => c.name)));
    };
    listed().then(send, () => {
      send([]);
    });
  };

  /** Stops the document's subscriptions and cancels a confirmation it has open. */
  const stopAll = () => {
    for (const stop of subs.values()) stop();
    if (dev) dev.subscriptions -= subs.size;
    subs.clear();
    if (open !== null && useConfirmStore.getState().pending === open) answerConfirm(false);
    open = null;
  };

  /** Runs ask after this frame's earlier confirmations; never once its document is gone. */
  const queued = (forDoc: number, ask: () => Promise<boolean>): Promise<boolean> => {
    const next = confirms.then(async () => {
      if (disposed || forDoc !== doc) return false;
      const answer = ask();
      // requestConfirm opens its dialog at once; a command's own presenter may not use it.
      const mine = useConfirmStore.getState().pending;
      open = mine;
      try {
        return await answer;
      } finally {
        if (open === mine) open = null;
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
    const asked = { declined: false };
    try {
      const spec = await listed().then(
        (cmds) => cmds.find((c) => c.name === verb),
        () => undefined,
      );
      const cwd = useThreadsStore.getState().byId[threadId]?.worktreePath ?? "";
      const callArgs = spec ? fillPageArgs(args, spec.args, { threadId, cwd }) : args;
      const res = await invokeConfirmed(verb, callArgs, pageContext(threadId), `${frame.pageName}, a page in ${useThreadsStore.getState().byId[threadId]?.name || threadId}`, {
        around: async (ask) => {
          const yes = await queued(forDoc, ask);
          if (!yes) asked.declined = true;
          return yes;
        },
      });
      if (asked.declined) fail(forDoc, id, verb, { code: "declined", message: "the user declined" }, res);
      else post(forDoc, okResult(id, res ?? { message: "", resultJson: "" }));
    } catch (err) {
      fail(forDoc, id, verb, bridgeErrorOf(err));
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

  return {
    loaded: () => {
      doc++;
      stopAll();
      ready(doc);
    },
    receive: (data) => {
      if (disposed) return;
      const m = parsePageMessage(data);
      if (!m) return;
      const forDoc = doc;
      switch (m.kind) {
        case "hello":
          ready(forDoc);
          return;
        case "run":
          void run(forDoc, m.id, m.verb, m.args);
          return;
        case "on":
          on(forDoc, m.id, m.source);
          return;
        case "off":
          unsubscribe(m.id);
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
      if (dev) dev.hosts--;
    },
  };
}
