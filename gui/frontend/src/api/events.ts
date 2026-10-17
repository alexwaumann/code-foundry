import { ClientKind, EventService, type Event } from "@/gen/codefoundry/v1/events_pb";
import { toActionEventView, type ActionEventView } from "./actions";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, isPageVisible, type Heartbeat } from "./stream";
import { toGhEventView, type GhEventView } from "./gh";
import { toGitOpsEventView, type GitOpsEventView } from "./gitops";
import { toProjectEventView, type ProjectEventView } from "./project";
import { toThreadListEventView, type ThreadListEventView } from "./threads";
import { toSettingsSnapshotView, type SettingsSnapshotView } from "./settings";
import { toTerminalEventView, type TerminalEventView } from "./terminal";
import { toThreadEventView, type ThreadEventView } from "./thread";
import { toUiIntentView, type UiIntentView } from "./ui";
import { toUpdateEventView, type UpdateEventView } from "./update";
import { toWorkspaceEventView, type WorkspaceEventView } from "./workspace";

export type { GhEventView } from "./gh";

/**
 * One item of the multiplexed EventService stream, tagged by source. The GUI holds
 * exactly one of these streams (HTTP/1.1 allows 6 connections per origin).
 */
export type EventView =
  | { source: "repo"; event: ProjectEventView }
  | { source: "workspace"; event: WorkspaceEventView }
  | { source: "terminal"; event: TerminalEventView }
  | { source: "threadList"; event: ThreadListEventView }
  | { source: "thread"; event: ThreadEventView }
  | { source: "gh"; event: GhEventView }
  | { source: "gitops"; event: GitOpsEventView }
  | { source: "ui"; event: UiIntentView }
  | { source: "settings"; event: SettingsSnapshotView }
  | { source: "update"; event: UpdateEventView }
  | { source: "action"; event: ActionEventView };

export function toEventView(ev: Event): EventView | null {
  const e = ev.event;
  switch (e.case) {
    case "project": {
      const v = toProjectEventView(e.value);
      return v && { source: "repo", event: v };
    }
    case "workspace": {
      const v = toWorkspaceEventView(e.value);
      return v && { source: "workspace", event: v };
    }
    case "terminal": {
      const v = toTerminalEventView(e.value);
      return v && { source: "terminal", event: v };
    }
    case "threadList": {
      const v = toThreadListEventView(e.value);
      return v && { source: "threadList", event: v };
    }
    case "thread": {
      const v = toThreadEventView(e.value);
      return v && { source: "thread", event: v };
    }
    case "gh": {
      const v = toGhEventView(e.value);
      return v && { source: "gh", event: v };
    }
    case "gitops": {
      const v = toGitOpsEventView(e.value);
      return v && { source: "gitops", event: v };
    }
    case "ui": {
      const v = toUiIntentView(e.value);
      return v && { source: "ui", event: v };
    }
    case "settings": {
      const s = e.value.event;
      return s.case === "snapshot" ? { source: "settings", event: toSettingsSnapshotView(s.value) } : null;
    }
    case "update": {
      const v = toUpdateEventView(e.value);
      return v && { source: "update", event: v };
    }
    case "action": {
      const v = toActionEventView(e.value);
      return v && { source: "action", event: v };
    }
    default:
      return null;
  }
}

/**
 * The open EventService.Watch as the daemon knows it: the client id this stream sent
 * and the visibility the daemon last heard for it. The daemon paces GitHub polling by
 * whether a GUI is connected and visible (docs/notes/gh-poll-tiers.md).
 */
interface Watching {
  id: string;
  conn: DaemonConnection;
  reported: boolean;
}

let watching: Watching | null = null;
let reports: Promise<void> = Promise.resolve();

/** A fresh client id per stream (getRandomValues works outside secure contexts too). */
function newClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tells the daemon the page's current visibility over SetClientState, when the open
 * stream reported something else. Calls run one at a time and each reads the
 * visibility when it runs, so the last word is always the current state. Failures are
 * dropped: before the stream has joined (watchEvents calls this again on its first
 * message), with an older daemon, or once the stream is gone (the next connect sends
 * the state in its request).
 */
export function reportVisibility(): Promise<void> {
  reports = reports.then(sendVisibility);
  return reports;
}

async function sendVisibility(): Promise<void> {
  const w = watching;
  const visible = isPageVisible();
  if (!w || w.reported === visible) return;
  try {
    const c = await w.conn.client(EventService);
    await c.setClientState({ clientId: w.id, visible }, { timeoutMs: 5_000 });
    w.reported = visible;
  } catch {
    // See reportVisibility.
  }
}

/**
 * Opens EventService.Watch (all sources) as a GUI client with the page's visibility and
 * yields mapped events and HEARTBEAT for heartbeats.
 */
export async function* watchEvents(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<EventView | Heartbeat> {
  const c = await conn.client(EventService);
  const me: Watching = { id: newClientId(), conn, reported: isPageVisible() };
  watching = me;
  try {
    let first = true;
    for await (const ev of c.watch({ clientKind: ClientKind.GUI, clientId: me.id, visible: me.reported }, { signal })) {
      if (first) {
        // The daemon has registered the stream: catch up on a change made while it opened.
        first = false;
        void reportVisibility();
      }
      if (ev.event.case === "heartbeat") {
        yield HEARTBEAT;
        continue;
      }
      const v = toEventView(ev);
      if (v) yield v;
    }
  } finally {
    if (watching === me) watching = null;
  }
}
