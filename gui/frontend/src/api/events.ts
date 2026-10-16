import { EventService, type Event } from "@/gen/codefoundry/v1/events_pb";
import { toActionEventView, type ActionEventView } from "./actions";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, type Heartbeat } from "./stream";
import { toGhEventView, type GhEventView } from "./gh";
import { toGitOpsEventView, type GitOpsEventView } from "./gitops";
import { toRepoEventView, type RepoEventView } from "./repo";
import { toSessionEventView, type SessionEventView } from "./session";
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
  | { source: "repo"; event: RepoEventView }
  | { source: "workspace"; event: WorkspaceEventView }
  | { source: "terminal"; event: TerminalEventView }
  | { source: "session"; event: SessionEventView }
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
    case "repo": {
      const v = toRepoEventView(e.value);
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
      const v = toSessionEventView(e.value);
      return v && { source: "session", event: v };
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

/** Opens EventService.Watch (all sources) and yields mapped events and HEARTBEAT for heartbeats. */
export async function* watchEvents(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<EventView | Heartbeat> {
  const c = await conn.client(EventService);
  for await (const ev of c.watch({}, { signal })) {
    if (ev.event.case === "heartbeat") {
      yield HEARTBEAT;
      continue;
    }
    const v = toEventView(ev);
    if (v) yield v;
  }
}
