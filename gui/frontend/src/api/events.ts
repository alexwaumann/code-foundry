import { EventService, type Event } from "@/gen/codefoundry/v1/events_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { toGhEventView, type GhEventView } from "./gh";
import { toRepoEventView, type RepoEventView } from "./repo";
import { toSessionEventView, type SessionEventView } from "./session";
import { toTerminalEventView, type TerminalEventView } from "./terminal";
import { toUiIntentView, type UiIntentView } from "./ui";

export type { GhEventView } from "./gh";

/**
 * One item of the multiplexed EventService stream, tagged by source. The GUI holds
 * exactly one of these streams (HTTP/1.1 allows 6 connections per origin).
 */
export type EventView =
  | { source: "repo"; event: RepoEventView }
  | { source: "terminal"; event: TerminalEventView }
  | { source: "session"; event: SessionEventView }
  | { source: "gh"; event: GhEventView }
  | { source: "ui"; event: UiIntentView };

export function toEventView(ev: Event): EventView | null {
  const e = ev.event;
  switch (e.case) {
    case "repo": {
      const v = toRepoEventView(e.value);
      return v && { source: "repo", event: v };
    }
    case "terminal": {
      const v = toTerminalEventView(e.value);
      return v && { source: "terminal", event: v };
    }
    case "session": {
      const v = toSessionEventView(e.value);
      return v && { source: "session", event: v };
    }
    case "gh": {
      const v = toGhEventView(e.value);
      return v && { source: "gh", event: v };
    }
    case "ui": {
      const v = toUiIntentView(e.value);
      return v && { source: "ui", event: v };
    }
    default:
      return null;
  }
}

/** Opens EventService.Watch (all sources) and yields mapped events. */
export async function* watchEvents(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<EventView> {
  const c = await conn.client(EventService);
  for await (const ev of c.watch({}, { signal })) {
    const v = toEventView(ev);
    if (v) yield v;
  }
}
