/**
 * Snoozing a thread until an event (docs/notes/snooze-until-event.md): what a thread waits
 * on (Thread.snooze_event) and what it can wait on now (thread.snooze.events' JSON), as view
 * models. Generated types stay here.
 */
import { fromJsonString } from "@bufbuild/protobuf";
import { SnoozeEventsResponseSchema, type ThreadSnoozeEvent } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { ms } from "./timestamp";

/** What a snoozed thread waits on. */
export interface ThreadSnoozeEventView {
  kind: "pull_request" | "plugin";
  /** "owner/name#812", or "<plugin>/<source>". */
  target: string;
  /** A pull request's condition (checks_done, merged, …); "fired" for a plugin. */
  condition: string;
  args: Readonly<Record<string, string>>;
  /** The pull request's title, or the wake source's. */
  title: string;
  /** The plugin's display name; "" for a pull request. */
  pluginName: string;
  /** The sidebar row's few words: "#812 checks", "#790 merged", "deploy". */
  label: string;
  /** The end of "Snoozed until …": "checks finish on #812". */
  waitingFor: string;
  sinceMs: number | null;
}

export function toSnoozeEventView(e: ThreadSnoozeEvent | undefined): ThreadSnoozeEventView | null {
  if (!e) return null;
  return {
    kind: e.kind === "plugin" ? "plugin" : "pull_request",
    target: e.target,
    condition: e.condition,
    args: { ...e.args },
    title: e.title,
    pluginName: e.pluginName,
    label: e.label,
    waitingFor: e.waitingFor,
    sinceMs: ms(e.since),
  };
}

/** One of the thread's open pull requests and the events it can still wait for. */
export interface SnoozePullRequestView {
  target: string;
  number: number;
  title: string;
  /** Pending conditions in menu order: checks_done, review, merged, comment, head_pushed, closed, review_requested. */
  conditions: string[];
}

/** A running plugin's wake source, with the args a snooze on it takes for this thread. */
export interface SnoozePluginView {
  target: string;
  title: string;
  pluginName: string;
  args: Readonly<Record<string, string>>;
}

/** What a thread can be snoozed until now. */
export interface SnoozeEventsView {
  /** Newest first. */
  pullRequests: SnoozePullRequestView[];
  plugins: SnoozePluginView[];
  /** The "<plugin>/<source>" the user last snoozed on, newest first. */
  recentPlugins: string[];
}

export const NO_SNOOZE_EVENTS: SnoozeEventsView = { pullRequests: [], plugins: [], recentPlugins: [] };

/** thread.snooze.events' JSON (SnoozeEventsResponse); null when it is not one. */
export function parseSnoozeEvents(json: string): SnoozeEventsView | null {
  try {
    const m = fromJsonString(SnoozeEventsResponseSchema, json || "{}", { ignoreUnknownFields: true });
    return {
      pullRequests: m.pullRequests.map((p) => ({ target: p.target, number: p.number, title: p.title, conditions: [...p.conditions] })),
      plugins: m.plugins.map((p) => ({ target: p.target, title: p.title, pluginName: p.pluginName, args: { ...p.args } })),
      recentPlugins: [...m.recentPlugins],
    };
  } catch {
    return null;
  }
}
