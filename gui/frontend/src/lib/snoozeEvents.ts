/**
 * The Until event menu (docs/notes/snooze-until-event.md), pure: what its submenu offers from
 * what the thread can wait on now (thread.snooze.events), the setting threads.snooze_events
 * and the plugin sources the user snoozed on lately; the More events list; and the
 * thread.snooze args an event takes.
 */
import type { SnoozeEventsView, SnoozePluginView } from "@/api/snoozeEvents";

/** The setting that says which events the submenu offers (internal/store/settings KeySnoozeEvents). */
export const SNOOZE_EVENTS_KEY = "threads.snooze_events";

/** The pull request events, in menu order, with their words. */
export const PR_EVENTS: readonly { condition: string; label: string }[] = [
  { condition: "checks_done", label: "Checks finish" },
  { condition: "review", label: "Reviewed" },
  { condition: "merged", label: "Merged" },
  { condition: "comment", label: "New comment" },
  { condition: "head_pushed", label: "New push" },
  { condition: "closed", label: "Closed" },
  { condition: "review_requested", label: "Review requested" },
];

/** The setting's default: Checks finish, Reviewed, Merged. */
export const DEFAULT_SNOOZE_EVENTS = "checks_done review merged";

/** At most this many pull requests, and this many plugin events, in the submenu. */
export const MENU_CAP = 3;

/** A pull request event's words ("Checks finish"); the condition itself when unknown. */
export function prEventLabel(condition: string): string {
  return PR_EVENTS.find((e) => e.condition === condition)?.label ?? condition;
}

/** A plugin source's word in the setting: "plugin:<plugin>/<source>". */
export function pluginEventKey(target: string): string {
  return `plugin:${target}`;
}

/** The setting's words as a set ("none" and "" are empty). */
export function parseSnoozeEventsSetting(value: string | undefined): Set<string> {
  const words = (value ?? DEFAULT_SNOOZE_EVENTS).split(/\s+/).filter((w) => w !== "" && w !== "none");
  return new Set(words);
}

/** The set as the setting's value: pull request events in menu order, then plugin sources sorted; "none" when empty. */
export function formatSnoozeEventsSetting(checked: ReadonlySet<string>): string {
  const prs = PR_EVENTS.map((e) => e.condition).filter((c) => checked.has(c));
  const plugins = [...checked].filter((w) => w.startsWith("plugin:")).sort();
  const all = [...prs, ...plugins];
  return all.length === 0 ? "none" : all.join(" ");
}

/** A snooze until an event, as the menu picks it. */
export type SnoozeEventPick = { kind: "pull_request"; target: string; condition: string } | { kind: "plugin"; target: string; args: Readonly<Record<string, string>> };

/** The thread.snooze args a pick takes: until-pr with on, or until-plugin with its args (one name=value per line, as the CLI joins a repeated flag). */
export function snoozeEventArgs(p: SnoozeEventPick): Record<string, string> {
  if (p.kind === "pull_request") return { "until-pr": p.target, on: p.condition };
  const lines = Object.entries(p.args)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return { "until-plugin": p.target, ...(lines.length > 0 ? { arg: lines.join("\n") } : {}) };
}

/** One pull request's group in the submenu: its label line and its events. */
export interface MenuPullRequest {
  target: string;
  number: number;
  title: string;
  events: { condition: string; label: string }[];
}

/** What the submenu shows. */
export interface UntilEventMenu {
  pullRequests: MenuPullRequest[];
  plugins: SnoozePluginView[];
}

/** Whether the thread can wait on anything now (the Until event item is hidden otherwise). */
export function hasSnoozeEvents(evs: SnoozeEventsView): boolean {
  return evs.plugins.length > 0 || evs.pullRequests.some((p) => p.conditions.length > 0);
}

/**
 * The submenu: at most three pull requests (newest first, as the daemon lists them), each with
 * its pending events the setting checks (one with none left out); then at most three plugin
 * events: the sources the user snoozed on most recently that the thread can use now (newest
 * first), filled up, when fewer than three, with the checked ones in the daemon's order.
 */
export function untilEventMenu(evs: SnoozeEventsView, checked: ReadonlySet<string>): UntilEventMenu {
  const pullRequests: MenuPullRequest[] = [];
  for (const p of evs.pullRequests) {
    if (pullRequests.length >= MENU_CAP) break;
    const events = PR_EVENTS.filter((e) => checked.has(e.condition) && p.conditions.includes(e.condition));
    if (events.length > 0) pullRequests.push({ target: p.target, number: p.number, title: p.title, events });
  }
  const byTarget = new Map(evs.plugins.map((p) => [p.target, p]));
  const plugins: SnoozePluginView[] = [];
  const add = (target: string) => {
    const p = byTarget.get(target);
    if (p && plugins.length < MENU_CAP && !plugins.includes(p)) plugins.push(p);
  };
  for (const t of evs.recentPlugins) add(t);
  for (const p of evs.plugins) if (checked.has(pluginEventKey(p.target))) add(p.target);
  return { pullRequests, plugins };
}

/** One row of More events: its group, its words, what typing matches, and the pick. */
export interface EventRow {
  /** Unique: "pr:<target>:<condition>", "plugin:<target>". */
  key: string;
  group: string;
  label: string;
  /** On the right: the plugin's name. */
  hint: string;
  /** What the filter matches beside the label ("812", the title, the plugin). */
  keywords: string[];
  pick: SnoozeEventPick;
}

/** Every event the thread can wait on now, grouped as the submenu (one group per pull request, then Plugins), checked or not. */
export function moreEventRows(evs: SnoozeEventsView): EventRow[] {
  const rows: EventRow[] = [];
  for (const p of evs.pullRequests) {
    const group = `#${String(p.number)} ${p.title}`.trim();
    for (const c of PR_EVENTS.filter((e) => p.conditions.includes(e.condition))) {
      rows.push({
        key: `pr:${p.target}:${c.condition}`,
        group,
        label: c.label,
        hint: "",
        keywords: [String(p.number), `#${String(p.number)}`, p.title, p.target, c.condition.replace("_", " ")],
        pick: { kind: "pull_request", target: p.target, condition: c.condition },
      });
    }
  }
  for (const p of evs.plugins) {
    rows.push({ key: `plugin:${p.target}`, group: "Plugins", label: p.title, hint: p.pluginName, keywords: [p.pluginName, p.target], pick: { kind: "plugin", target: p.target, args: p.args } });
  }
  return rows;
}

/**
 * Whether a More events row matches what was typed: every word of it is in the row's label or
 * keywords, case-insensitively ("812 merged", "deploy").
 */
export function eventRowMatches(row: EventRow, query: string): boolean {
  const hay = [row.label, row.hint, ...row.keywords].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .every((w) => hay.includes(w.replace(/^#/, "")));
}
