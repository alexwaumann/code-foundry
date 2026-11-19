/**
 * The bell's notifications in the mock daemon (docs/notes/notifications-1-store.md,
 * notifications-3-bell.md): NotificationService.List, the EventService notification source (the
 * whole snapshot per change with arrived and updated ids) and the notification.* commands the GUI
 * runs (dismiss, snooze, act, seen, clear), plus post, list and withdraw for the CLI's shape. Simplified
 * from internal/store/notification: one per source and key, a changed post of a shown one is an
 * update in place, a dismissed or resolved one comes back only with changed content, snooze ends
 * on a one-second tick. Seen as the daemon keeps it (docs/notes/notification-seen.md): an arrival
 * is unseen, an update in place keeps it, act and notification.seen see it; a quiet post or seed
 * (no arrival: what was there before the GUI connected) is seen unless seen=0 says otherwise.
 * Empty after a reset, so the bell is quiet unless a test posts.
 *
 * Controls (mock/server.ts):
 *   POST /__mock/notifications/post?title=…[&body=…&level=info|warning|error&ts=1&thread=s-4&seen=1
 *        &source=hello|command|…&key=…&action=Label|kind[|arg][|resolves]…]   (a post: an arrival,
 *        or an update of the same source and key; kind is command, send (arg: the text, to thread),
 *        start (arg: the prompt) or open (arg: the URL); resolves 0|1 overrides the kind's default)
 *   POST /__mock/notifications/withdraw?key=…[&source=…]   (the source takes it back)
 *   POST /__mock/notifications/seed[?quiet=1&seen=0|1]   (the sketch's five, one time-sensitive and
 *        two naming s-4, and one snoozed; quiet: as a snapshot, no arrivals, so nothing toasts;
 *        seen: whether they are seen, by default as quiet says)
 *   POST /__mock/notifications/plugin-health?name=hello&display=Hello&state=failed|off|running[&reason=…]
 *        (the daemon's source "plugins", internal/daemon/plugin_health.go: failed posts the error
 *        card with Restart and Open plugins, off the warning one the daemon posts when it turned
 *        the plugin off, running withdraws it)
 *   POST /__mock/notifications/github[?quiet=1&seen=0|1]   (the daemon's four GitHub cards: review again,
 *        review requested, changes requested naming s-4, a merge conflict; Open PR runs
 *        view.open.pr --repo-slug --number --focus, the pull request's tab of no thread)
 *   POST /__mock/notifications/act-fail?message=…   (the next notification.act fails with it; empty: none)
 *   GET  /__mock/notifications                  ({ notifications, calls }: every one with its state)
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { NotificationLevel, NotificationStatus, type NotificationActionSchema, type NotificationEventSchema, type NotificationSnapshotSchema } from "../src/gen/codefoundry/v1/notification_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";
import type { SkillCommand } from "./skills";

/** The daemon's own source for plugins that stopped (internal/daemon/plugin_health.go). */
const PLUGINS_SOURCE = "plugins";

/** The daemon's own source for the GitHub poll's cards (internal/daemon/github_notifications_rules.go). */
const GITHUB_SOURCE = "github";

/**
 * The host sources whose command actions the mock runs as the registry verb they name, as the
 * daemon's notification.act does (internal/command verbSources). The plugins source's are
 * recorded only, as before: the mock's view.settings takes no --page.
 */
const VERB_SOURCES = [GITHUB_SOURCE];

export type NotificationEventInit = MessageInitShape<typeof NotificationEventSchema>;
type SnapshotInit = MessageInitShape<typeof NotificationSnapshotSchema>;
type ActionInit = MessageInitShape<typeof NotificationActionSchema>;

type Level = "info" | "warning" | "error";
type State = "active" | "dismissed" | "withdrawn" | "resolved";

interface Action {
  label: string;
  kind: "command" | "send" | "start" | "open";
  /** The command's name, the send's text, the start's prompt, the URL. */
  arg: string;
  /** A command action's args. */
  args?: Record<string, string>;
  resolves: boolean;
}

interface Note {
  id: string;
  source: string;
  key: string;
  level: Level;
  timeSensitive: boolean;
  title: string;
  body: string;
  threadId: string;
  actions: Action[];
  state: State;
  createdAt: Date;
  arrivedAt: Date;
  snoozedUntil: Date | null;
  seen: boolean;
}

const LEVELS: Record<Level, NotificationLevel> = { info: NotificationLevel.INFO, warning: NotificationLevel.WARNING, error: NotificationLevel.ERROR };
const MINUTE = 60_000;

function content(n: Pick<Note, "level" | "timeSensitive" | "title" | "body" | "threadId" | "actions">): string {
  return JSON.stringify([n.level, n.timeSensitive, n.title, n.body, n.threadId, n.actions]);
}

export interface PostInput {
  source?: string;
  key?: string;
  level?: Level;
  timeSensitive?: boolean;
  title: string;
  body?: string;
  threadId?: string;
  actions?: Action[];
}

/** seed and github's seen=0|1; undefined: as quiet says. */
function seenParam(q: URLSearchParams): boolean | undefined {
  const v = q.get("seen");
  return v === null ? undefined : v === "1";
}

export class MockNotifications {
  private notes: Note[] = [];
  private version = 1;
  private nextId = 1;
  private actFail = "";
  readonly calls: string[] = [];

  constructor(
    private readonly deps: {
      publish: (ev: NotificationEventInit) => void;
      hasThread: (id: string) => boolean;
      send: (threadId: string, text: string) => void;
      /** Runs a registry verb as notification.act does: with the caller's view and nothing else of its context. */
      invoke?: (name: string, args: Record<string, string>, ctx: UiContext) => string | Promise<InvokeOut>;
      /** Whether a thread's own tab is open in the space the window shows (thread.look skips it); false when unknown. */
      onScreen?: (threadId: string) => boolean;
    },
  ) {
    setInterval(() => {
      this.tick();
    }, 1000).unref();
  }

  reset(): void {
    this.notes = [];
    this.calls.length = 0;
    this.actFail = "";
    this.changed([], []);
  }

  private msg(n: Note) {
    return {
      id: n.id,
      source: n.source,
      key: n.key,
      level: LEVELS[n.level],
      timeSensitive: n.timeSensitive,
      title: n.title,
      body: n.body,
      threadId: n.threadId,
      actions: n.actions.map((a): ActionInit => {
        const base = { label: a.label, resolves: a.resolves };
        switch (a.kind) {
          case "command":
            return { ...base, kind: { case: "command", value: { command: a.arg, args: { ...a.args } } } };
          case "send":
            return { ...base, kind: { case: "send", value: { threadId: n.threadId, text: a.arg } } };
          case "start":
            return { ...base, kind: { case: "start", value: { prompt: a.arg } } };
          case "open":
            return { ...base, kind: { case: "open", value: { url: a.arg } } };
        }
      }),
      status: n.snoozedUntil ? NotificationStatus.SNOOZED : NotificationStatus.SHOWN,
      createdAt: timestampFromDate(n.createdAt),
      updatedAt: timestampFromDate(n.arrivedAt),
      arrivedAt: timestampFromDate(n.arrivedAt),
      ...(n.snoozedUntil ? { snoozedUntil: timestampFromDate(n.snoozedUntil) } : {}),
      seen: n.seen,
    };
  }

  /** The daemon's order: shown first (time-sensitive, then the newest arrival), then snoozed by when they come back. */
  private active(): Note[] {
    const live = this.notes.filter((n) => n.state === "active");
    const shown = live.filter((n) => !n.snoozedUntil).sort((a, b) => Number(b.timeSensitive) - Number(a.timeSensitive) || b.arrivedAt.getTime() - a.arrivedAt.getTime());
    const snoozed = live.filter((n) => n.snoozedUntil).sort((a, b) => (a.snoozedUntil?.getTime() ?? 0) - (b.snoozedUntil?.getTime() ?? 0));
    return [...shown, ...snoozed];
  }

  snapshot(): SnapshotInit {
    const active = this.active();
    const shown = active.filter((n) => !n.snoozedUntil);
    return {
      notifications: active.map((n) => this.msg(n)),
      timeSensitive: shown.filter((n) => n.timeSensitive).length,
      unseen: shown.filter((n) => !n.seen).length,
      version: BigInt(this.version),
    };
  }

  /** A connect's event: the snapshot, no arrivals. */
  event(): NotificationEventInit {
    return { snapshot: this.snapshot() };
  }

  json(): { notifications: (Note & { status: string })[]; calls: string[] } {
    return { notifications: this.notes.map((n) => ({ ...n, status: n.state === "active" ? (n.snoozedUntil ? "snoozed" : "shown") : n.state })), calls: this.calls };
  }

  private changed(arrived: string[], updated: string[]): void {
    this.version++;
    this.deps.publish({ snapshot: this.snapshot(), arrivedIds: arrived, updatedIds: updated });
  }

  private tick(): void {
    const now = Date.now();
    const woke = this.notes.filter((n) => n.state === "active" && n.snoozedUntil && n.snoozedUntil.getTime() <= now);
    if (woke.length === 0) return;
    for (const n of woke) {
      n.snoozedUntil = null;
      n.arrivedAt = new Date(now);
      n.seen = false;
    }
    this.changed(woke.map((n) => n.id), []);
  }

  /** A post: a new one arrives; the same source and key with other content updates a shown one in place, or brings a closed one back. */
  post(p: PostInput, opts: { quiet?: boolean; arrivedAt?: Date; seen?: boolean } = {}): Note {
    if (!p.title.trim()) throw new CommandError("invalid", "a notification needs a title");
    if (p.threadId && !this.deps.hasThread(p.threadId)) throw new CommandError("notfound", `no thread ${p.threadId}`);
    const source = p.source ?? "command";
    const fields = { level: p.level ?? "info", timeSensitive: p.timeSensitive ?? false, title: p.title, body: p.body ?? "", threadId: p.threadId ?? "", actions: (p.actions ?? []).slice(0, 3) };
    // The daemon hashes title, body and thread; the mock keeps them readable.
    const key = p.key || `auto:${fields.title}|${fields.body}|${fields.threadId}`;
    const now = opts.arrivedAt ?? new Date();
    const seen = opts.seen ?? opts.quiet ?? false;
    const old = this.notes.find((n) => n.source === source && n.key === key);
    if (old) {
      const same = content(old) === content(fields);
      if (same && old.state !== "withdrawn") return old;
      Object.assign(old, fields);
      if (old.state === "active") {
        this.changed([], [old.id]);
        return old;
      }
      Object.assign(old, { state: "active", arrivedAt: now, snoozedUntil: null, seen });
      this.changed(opts.quiet ? [] : [old.id], []);
      return old;
    }
    const n: Note = { id: `n-${String(this.nextId++).padStart(12, "0")}`, source, key, ...fields, state: "active", createdAt: now, arrivedAt: now, snoozedUntil: null, seen };
    this.notes.push(n);
    this.changed(opts.quiet ? [] : [n.id], []);
    return n;
  }

  withdraw(key: string, source = "command"): void {
    const n = this.notes.find((x) => x.source === source && x.key === key && x.state === "active");
    if (!n) throw new CommandError("notfound", `no active notification ${source}/${key}`);
    n.state = "withdrawn";
    this.changed([], []);
  }

  private find(id: string): Note {
    const n = this.notes.find((x) => x.id === id || x.id.endsWith(id));
    if (!n || n.state !== "active") throw new CommandError("notfound", `no active notification ${id}`);
    return n;
  }

  /** The sketch's bell: five shown (one time-sensitive, two naming s-4) and one snoozed. */
  seed(quiet: boolean, seen = quiet): void {
    const t = Date.now();
    const at = (min: number) => ({ quiet, seen, arrivedAt: new Date(t - min * MINUTE) });
    this.post({ source: "acme-data", key: "cf-212", title: "CF-212 Sidebar count is wrong after archive", actions: [{ label: "Start a thread", kind: "start", arg: "Look into CF-212", resolves: true }, { label: "Open ticket", kind: "open", arg: "https://example.com/CF-212", resolves: false }] }, at(60));
    this.post({ source: "command", key: "rotate-key", title: "Rotate the staging API key", actions: [{ label: "Open task", kind: "open", arg: "https://example.com/task/7", resolves: false }] }, at(45));
    this.post({ source: "acme-data", key: "retry", title: "Follow up on the retry", threadId: "s-4", actions: [{ label: "Open task", kind: "open", arg: "https://example.com/task/8", resolves: false }] }, at(9));
    this.post({ source: "test-watcher", key: "deploy-482", level: "error", title: "Stage integration failed", body: "cf-deploy #482 · 3 of 212 tests failed", threadId: "s-4", actions: [{ label: "Send to thread", kind: "send", arg: "The integration stage failed: 3 of 212 tests.", resolves: true }, { label: "Open log", kind: "open", arg: "https://example.com/log/482", resolves: false }] }, at(2));
    this.post({ source: "hello", key: "nightly-91", level: "warning", timeSensitive: true, title: "cf-nightly #91 is waiting to deploy", body: "Stage Promote · started by a timer", actions: [{ label: "Continue", kind: "command", arg: "continue", resolves: true }, { label: "Abort", kind: "command", arg: "abort", resolves: true }, { label: "Open build", kind: "open", arg: "https://example.com/build/91", resolves: false }] }, at(4));
    const later = this.post({ source: "acme-data", key: "standup", title: "Standup notes are due" }, at(30));
    later.snoozedUntil = new Date(t + 3 * 60 * MINUTE);
    this.changed([], []);
  }

  /**
   * The daemon's four GitHub notifications (docs/notes/notifications-github.md), as it words them,
   * for pull requests the mock's dashboard holds (mock/github.ts), so Open PR's tab shows one; the
   * changes-requested one names s-4, a thread linked to its pull request.
   */
  seedGitHub(quiet: boolean, seen = quiet): void {
    const t = Date.now();
    const at = (min: number) => ({ quiet, seen, arrivedAt: new Date(t - min * MINUTE) });
    // Open PR: the pull request's tab in the app (view.open.pr --repo-slug, a tab of no thread), brought forward; the card stays.
    const open = (url: string): Action => {
      const [, slug = "", number = ""] = /\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url) ?? [];
      return { label: "Open PR", kind: "command", arg: "view.open.pr", args: { "repo-slug": slug, number, focus: "true" }, resolves: false };
    };
    const start = (label: string, prompt: string): Action => ({ label, kind: "start", arg: prompt, resolves: true });
    const cf = "alexwaumann/code-foundry";
    const gp = "alexwaumann/ghostty-playground";
    const url = (slug: string, n: number) => `https://github.com/${slug}/pull/${String(n)}`;
    this.post({ source: "github", key: `pr/${gp}#14/review-again`, timeSensitive: true, title: "Review again", body: `${gp} #14 renderer: subpixel glyph positioning · by teammate-kim, changed since your review`, actions: [open(url(gp, 14)), start("Review in a thread", `Review pull request ${gp}#14 again.`)] }, at(1));
    this.post({ source: "github", key: `pr/${cf}#139/review-requested`, timeSensitive: true, title: "Review requested", body: `${cf} #139 feat(thread): JSONL transcript discovery · by teammate-kim, requested from you`, actions: [open(url(cf, 139)), start("Review in a thread", `Review pull request ${cf}#139.`)] }, at(3));
    this.post({ source: "github", key: `pr/${cf}#145/changes-requested`, level: "warning", title: "Changes requested on your PR", body: `${cf} #145 fix(terminal): resize race between attach and first output · teammate-lee requested changes`, threadId: "s-4", actions: [open(url(cf, 145)), { label: "Send to thread", kind: "send", arg: `Changes were requested on ${cf}#145: address them and push.`, resolves: true }] }, at(6));
    this.post({ source: "github", key: `pr/${gp}#12/conflict`, level: "warning", title: "Merge conflict on your PR", body: `${gp} #12 renderer: port glyph cache to the new atlas · conflicts with main`, actions: [open(url(gp, 12)), start("Fix in a thread", `My pull request ${gp}#12 has a merge conflict with main: resolve it and push.`)] }, at(12));
    this.changed([], []);
  }

  /** POST /__mock/notifications/<action>. */
  control(action: string, q: URLSearchParams): unknown {
    switch (action) {
      case "post": {
        const level = q.get("level") ?? "info";
        if (level !== "info" && level !== "warning" && level !== "error") throw new CommandError("invalid", "level is info, warning or error");
        const actions = q.getAll("action").map((spec): Action => {
          const [label = "", kind = "open", arg = "", resolves] = spec.split("|");
          if (kind !== "command" && kind !== "send" && kind !== "start" && kind !== "open") throw new CommandError("invalid", `unknown action kind ${kind}`);
          return { label, kind, arg, resolves: resolves === undefined ? kind !== "open" : resolves === "1" };
        });
        const n = this.post(
          { source: q.get("source") ?? "command", key: q.get("key") ?? "", level, timeSensitive: q.get("ts") === "1", title: q.get("title") ?? "", body: q.get("body") ?? "", threadId: q.get("thread") ?? "", actions },
          { seen: q.get("seen") === "1" },
        );
        return { id: n.id };
      }
      case "withdraw":
        this.withdraw(q.get("key") ?? "", q.get("source") ?? "command");
        return {};
      case "seed":
        this.seed(q.get("quiet") === "1", seenParam(q));
        return { notifications: this.active().length };
      case "plugin-health": {
        const name = q.get("name") ?? "hello";
        const display = q.get("display") ?? name;
        const state = q.get("state") ?? "failed";
        const open: Action = { label: "Open plugins", kind: "command", arg: "view.settings", resolves: false };
        if (state === "running") {
          this.withdraw(name, PLUGINS_SOURCE);
          return {};
        }
        if (state === "off") {
          const body = q.get("reason") ?? "Its permissions changed: enable it again to review them";
          return { id: this.post({ source: PLUGINS_SOURCE, key: name, level: "warning", title: `${display} was turned off`, body, actions: [open] }).id };
        }
        const body = q.get("reason") ?? "Crashed 5 times in 10m, last: exit status 2";
        const restart: Action = { label: "Restart", kind: "command", arg: "plugin.restart", resolves: false };
        return { id: this.post({ source: PLUGINS_SOURCE, key: name, level: "error", title: `${display} stopped`, body, actions: [restart, open] }).id };
      }
      case "github":
        this.seedGitHub(q.get("quiet") === "1", seenParam(q));
        return { notifications: this.active().length };
      case "act-fail":
        this.actFail = q.get("message") ?? "";
        return {};
      default:
        throw new CommandError("notfound", `unknown notifications control ${action}`);
    }
  }

  commands(): SkillCommand[] {
    const always = () => true;
    const id = { name: "id", type: ArgType.STRING, required: true, description: "The notification's id (a unique suffix will do)" };
    const cmd = (name: string, title: string, description: string, args: SkillCommand["cmd"]["args"], noPalette = true): SkillCommand["cmd"] => ({ name, title, category: "Notifications", description, keybindings: [], args, noPalette });
    const record = (name: string, a: Record<string, string>) => {
      this.calls.push(`${name} ${JSON.stringify(a)}`);
    };
    return [
      {
        cmd: cmd("notification.post", "Notifications: Post", "Put a notification in the bell.", [
          { name: "title", type: ArgType.STRING, required: true, description: "The title" },
          { name: "body", type: ArgType.STRING, required: false, description: "More detail" },
          { name: "level", type: ArgType.STRING, required: false, description: "info, warning or error" },
          { name: "key", type: ArgType.STRING, required: false, description: "Identifies it" },
          { name: "thread", type: ArgType.STRING, required: false, description: "The thread it is about" },
          { name: "time-sensitive", type: ArgType.BOOL, required: false, description: "Sort it first and count it in the Dock badge" },
        ]),
        when: always,
        run: (_c: UiContext | undefined, a) => {
          record("notification.post", a);
          const level = (a.level ?? "info") as Level;
          const n = this.post({ title: a.title ?? "", body: a.body, level, key: a.key, threadId: a.thread, timeSensitive: a["time-sensitive"] === "true" });
          return `posted notification ${n.id}: ${n.title}`;
        },
      },
      {
        // thread.look (internal/command/commands_thread_look.go): one warning, time-sensitive request per thread,
        // key look:<thread>, skipped while the thread is on screen in the window's space.
        cmd: {
          ...cmd("thread.look", "Ask the User to Look", "Ask the user to look at this thread while it waits, without changing its status.", [
            { name: "title", type: ArgType.STRING, required: false, description: "What to look at" },
            { name: "body", type: ArgType.STRING, required: false, description: "More detail" },
            { name: "id", type: ArgType.STRING, required: true, description: "The thread asking (default: the thread this runs in)" },
            { name: "withdraw", type: ArgType.BOOL, required: false, description: "Take the request back" },
          ]),
          category: "Thread",
        },
        when: always,
        run: (c: UiContext | undefined, a) => {
          record("thread.look", a);
          const thread = a.id || c?.activeThreadId || "";
          if (!thread) throw new CommandError("invalid", "id: give the thread asking");
          const key = `look:${thread}`;
          if (a.withdraw === "true") {
            if (!this.notes.some((n) => n.source === "command" && n.key === key && n.state === "active")) return `thread ${thread} was not asking the user to look`;
            this.withdraw(key);
            return `withdrew thread ${thread}'s request to look`;
          }
          if (!a.title) throw new CommandError("invalid", "title: say what the user should look at");
          if (this.deps.onScreen?.(thread)) return `not needed: thread ${thread} is on screen in the space the user's window shows; nothing was posted`;
          const n = this.post({ key, level: "warning", timeSensitive: true, title: a.title, body: a.body ?? "", threadId: thread });
          return `asked the user to look: the bell and this thread's row show it until they open the thread (${n.id})`;
        },
      },
      {
        cmd: cmd("notification.list", "Notifications: List", "List the notifications.", []),
        when: always,
        run: (_c, a) => {
          record("notification.list", a);
          return this.active().map((n) => `${n.id}\t${n.level}\t${n.source}\t${n.title}`).join("\n") || "no notifications";
        },
      },
      {
        cmd: cmd("notification.dismiss", "Notifications: Dismiss", "Dismiss a notification.", [id]),
        when: always,
        run: (_c, a) => {
          record("notification.dismiss", a);
          const n = this.find(a.id ?? "");
          n.state = "dismissed";
          n.snoozedUntil = null;
          this.changed([], []);
          return `dismissed notification ${n.id}: ${n.title}`;
        },
      },
      {
        cmd: cmd("notification.snooze", "Notifications: Snooze", "Hide a notification until a time.", [id, { name: "until", type: ArgType.STRING, required: true, description: "When it comes back" }]),
        when: always,
        run: (_c, a) => {
          record("notification.snooze", a);
          const n = this.find(a.id ?? "");
          const until = new Date(a.until ?? "");
          if (Number.isNaN(until.getTime())) throw new CommandError("invalid", `until ${a.until ?? ""} is not a time`);
          n.snoozedUntil = until;
          this.changed([], []);
          return `snoozed notification ${n.id} until ${until.toISOString()}`;
        },
      },
      {
        cmd: cmd("notification.act", "Notifications: Run Action", "Run one of a notification's actions.", [id, { name: "action", type: ArgType.INT, required: false, description: "The action's number" }]),
        when: always,
        run: (c, a) => {
          record("notification.act", a);
          const n = this.find(a.id ?? "");
          const i = Number(a.action ?? "1") - 1;
          const act = n.actions[i];
          if (!act) throw new CommandError("invalid", `notification ${n.id} has no action ${String(i + 1)}`);
          // The user acted on it, so they saw it: marked before the run, which may fail (as the daemon does).
          if (!n.seen) {
            n.seen = true;
            this.changed([], []);
          }
          if (this.actFail) {
            const message = this.actFail;
            this.actFail = "";
            throw new CommandError("unavailable", message);
          }
          if (act.kind === "send") this.deps.send(n.threadId, act.arg);
          const ran = act.kind === "command" && VERB_SOURCES.includes(n.source) ? this.deps.invoke?.(act.arg, { ...act.args }, { activeView: c?.activeView ?? "" } as UiContext) : undefined;
          const done = (): string => {
            if (act.resolves) {
              n.state = "resolved";
              this.changed([], []);
            }
            return `ran "${act.label}" on notification ${n.id}${act.resolves ? ", which is resolved" : ""}`;
          };
          // A verb that fails fails the act (the card's "<label> failed" toast) and leaves the card.
          return ran instanceof Promise ? ran.then(() => ({ message: done(), resultJson: "" })) : done();
        },
      },
      {
        cmd: cmd("notification.seen", "Notifications: Mark Seen", "Mark the bell's notifications seen; with an id, only that one.", [{ ...id, required: false }]),
        when: always,
        run: (_c, a) => {
          record("notification.seen", a);
          const which = a.id ? [this.find(a.id)] : this.notes.filter((n) => n.state === "active" && !n.snoozedUntil);
          const unseen = which.filter((n) => !n.seen);
          for (const n of unseen) n.seen = true;
          if (unseen.length > 0) this.changed([], []);
          if (unseen.length === 0) return a.id ? `notification ${which[0]?.id ?? ""} was seen already` : "no unseen notifications";
          return a.id ? `marked notification ${unseen[0]?.id ?? ""} seen` : `marked ${String(unseen.length)} notification${unseen.length === 1 ? "" : "s"} seen`;
        },
      },
      {
        cmd: cmd("notification.clear", "Notifications: Clear All", "Dismiss every notification in the bell.", [], false),
        when: always,
        run: (_c, a) => {
          record("notification.clear", a);
          const shown = this.notes.filter((n) => n.state === "active" && !n.snoozedUntil);
          for (const n of shown) n.state = "dismissed";
          if (shown.length === 0) return "no notifications to clear";
          this.changed([], []);
          return `dismissed ${String(shown.length)} notification${shown.length === 1 ? "" : "s"}`;
        },
      },
      {
        cmd: cmd("notification.withdraw", "Notifications: Withdraw", "Take back a notification posted with a key.", [{ name: "key", type: ArgType.STRING, required: true, description: "The key it was posted with" }]),
        when: always,
        run: (_c, a) => {
          record("notification.withdraw", a);
          this.withdraw(a.key ?? "");
          return `withdrew notification ${a.key ?? ""}`;
        },
      },
    ];
  }
}
