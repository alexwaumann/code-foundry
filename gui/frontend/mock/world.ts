/**
 * In-memory fake daemon state: repos, worktrees, threads (mock/thread.ts), shells with
 * scripted output, the command registry, and intent fan-out. Deterministic initial state; reset() restores it.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { EventSource, type EventSchema } from "../src/gen/codefoundry/v1/events_pb";
import type { RepoEventSchema, RepoSchema, WorktreeSchema } from "../src/gen/codefoundry/v1/repo_pb";
import { PermissionMode, ThreadState, ThreadStatus, type ThreadListEventSchema, type ThreadSchema } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { TerminalState, type AttachEventSchema, type TerminalEventSchema, type TerminalSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";
import type { WorkspaceEventSchema, WorkspaceSchema } from "../src/gen/codefoundry/v1/workspace_pb";
import { MockGitOps, type GitOpsEventInit, type InvokeOut } from "./gitops";
import { prDetailCall } from "./prDetail";
import { GhWorld, ghEvent, viewCommands } from "./github";
import { cloneExists } from "./clone";
import { HOME, projectFolder } from "./filesystem";
import { projectCommands } from "./create";
import { Hub } from "./hub";
import { MockSettings, MODEL_VALUES } from "./settings";
import { themesFor } from "../src/themes";
import { MockUpdater, type RestartCost } from "./update";
import { pageUsage, retiredUsage, sampleUsage, usageFields, type MockUsage } from "./usage";
import { ENTER_ALT, prompt, RESET, topFrame } from "./screens";
import { CommandError } from "./errors";
import { agentCounts, agentsCommands } from "./agents";
import { mcpCommands } from "./mcp";
import { MockActions } from "./actions";
import { CRASH_STDERR, MockThreadLogs, type SeedHistory, type ThreadState as ScriptedThreadState } from "./thread";
import { contextFields, recordResult, type MockContext } from "./context";

type TerminalInit = MessageInitShape<typeof TerminalSchema>;
type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;
type TerminalEventInit = MessageInitShape<typeof TerminalEventSchema>;
type RepoInit = MessageInitShape<typeof RepoSchema>;
type WorktreeInit = MessageInitShape<typeof WorktreeSchema>;
type RepoEventInit = MessageInitShape<typeof RepoEventSchema>;
type ThreadInit = MessageInitShape<typeof ThreadSchema>;
type ThreadListEventInit = MessageInitShape<typeof ThreadListEventSchema>;
export type EventInit = MessageInitShape<typeof EventSchema>;
type WorkspaceInit = MessageInitShape<typeof WorkspaceSchema>;
type WorkspaceEventInit = MessageInitShape<typeof WorkspaceEventSchema>;

/** A workspace: one branch as a worktree in several repos (the daemon's workspace store). */
export interface MockWorkspace {
  id: string;
  name: string;
  branch: string;
  members: { repoId: string; worktreePath: string }[];
  createdAt: Date;
}

interface MockThread {
  id: string;
  claudeSessionId: string;
  repoId: string;
  worktreePath: string;
  name: string;
  autoNamed: boolean;
  model: string;
  effort: string;
  state: ThreadState;
  /** Persisted like the daemon's: a stopped thread keeps it (busy becomes ERROR "interrupted"). */
  status: ThreadStatus;
  /** The detector's reason ("permission: Do you want to proceed?", "finished", "interrupted", …). */
  statusReason: string;
  /** When status or statusReason last changed. */
  statusChangedAt: Date;
  createdAt: Date;
  lastActivityAt: Date;
  exitCode: number;
  disconnectReason: string;
  /** Why the last start or run failed (stderr's last line); "" when nothing did. */
  lastError: string;
  /** thread.fork: the thread this one was forked from. */
  parentId: string;
  permissionMode: PermissionMode;
  baseRef: string;
  createdWorktree: boolean;
  /** The owning workspace; "" for a project thread. */
  workspaceId: string;
  /** A queued thread.run-in target; "" when none (published, not "persisted"). */
  pendingWorktreePath: string;
  /** thread.pin. */
  pinned: boolean;
  /** thread.archive: when it was archived; null when not. A message and pin(true) clear it, like the daemon. */
  archivedAt: Date | null;
  /**
   * thread.snooze: when it wakes; null when not snoozed. A message, pin(true) and archive
   * clear it, like the daemon; the tick (or POST /__mock/thread/wake) wakes it.
   */
  snoozedUntil: Date | null;
  /** An effort change waiting for the turn to end (thread.set-effort). */
  effortPending: boolean;
  /** Mock-only: a new thread's first message, sent once it connects (the daemon sends it after the handshake). */
  firstMessage: { text: string; attachments: string[]; composerText: string } | null;
  /** Mock-only: what runs once a started thread is up (a message that started it: its reply). */
  onReady: (() => void)[];
  /** Claude's pr-link records: one per URL, first-seen order (POST /__mock/link-pr). */
  linkedPullRequests: { slug: string; number: number; url: string; linkedAt: Date }[];
  /** Token usage buckets (mock/usage.ts; POST /__mock/usage). */
  usage: MockUsage[];
  /** The thread's context totals (mock/context.ts). */
  contextTokens: MockContext["contextTokens"];
  contextModel: MockContext["contextModel"];
  lastResultAt: MockContext["lastResultAt"];
  /** A pending API retry (Thread.retry; POST /__mock/thread/retry); null for none. */
  retry: { attempt: number; maxRetries: number; retryAt: Date; errorStatus: number; error: string } | null;
  /** Mock-only: seconds a queued run-in waits once the thread is not busy (the daemon waits for its prompt). */
  moveIn: number;
  /** Mock-only: seconds left before a STARTING/CLOSING thread settles. */
  settleIn: number;
  /** Mock-only: seconds until an unnamed thread gets `pendingName` (background naming). */
  nameIn: number;
  pendingName: string;
  /**
   * Mock-only: the clock leaves it alone (no settling, no busy/idle flip, no naming, no
   * queued move); POST /__mock/thread/hold. Specs that pin the sidebar order use it, since
   * starting and busy threads sit in the Working section.
   */
  held: boolean;
}

interface ArgDef {
  name: string;
  type: ArgType;
  required: boolean;
  description: string;
  enumValues?: string[];
  defaultValue?: string;
}

interface CmdDef {
  name: string;
  title: string;
  category: string;
  description: string;
  keybindings: string[];
  args: ArgDef[];
  /** Destructive: Invoke needs confirmed=true; renders the prompt from the context and args. */
  confirm?: (ctx: UiContext | undefined, args: Record<string, string>) => string;
  /** Like the daemon's Command.ConfirmIf: when set, confirmation is asked only when it returns true. */
  confirmIf?: (ctx: UiContext | undefined, args: Record<string, string>) => boolean;
}
export type UiIntentInit = MessageInitShape<typeof UiIntentSchema>;

type Kind = "top" | "shell" | "action";

// The terminal label contract (internal/termlabel, proto Terminal.labels).
const LABEL_KIND = "kind";
const LABEL_THREAD = "thread";
const LABEL_REPO = "repo";
const LABEL_WORKTREE = "worktree";
const KIND_SHELL = "shell";
const KIND_ACTION = "action";

/** termlabel.IsPanel: a shell or an action run (the bottom panel's terminals; what close and thread removal take). */
const isPanel = (labels: Record<string, string>) => labels[LABEL_KIND] === KIND_SHELL || labels[LABEL_KIND] === KIND_ACTION;

/** Labels of a shell terminal.new starts: owned by a worktree, and by a thread when threadId is set. */
function shellLabels(threadId: string, repoId: string, worktree: string): Record<string, string> {
  const l: Record<string, string> = { [LABEL_KIND]: KIND_SHELL, [LABEL_REPO]: repoId, [LABEL_WORKTREE]: worktree };
  if (threadId) l[LABEL_THREAD] = threadId;
  return l;
}

/** thread.archive archives (rather than unarchives): its `archived` arg, else the opposite of now. */
function archiving(s: { archivedAt: Date | null }, args: Record<string, string>): boolean {
  return args.archived === undefined || args.archived === "" ? s.archivedAt === null : args.archived === "true";
}

/**
 * thread.snooze's time: `clear` unsnoozes (null); `until` is RFC 3339 (what the GUI sends)
 * or a duration from now ("90s", "2m", "1h"; the CLI forms the tests need). It must be in
 * the future, like the daemon's.
 */
export function snoozeUntil(args: Record<string, string>, now = Date.now()): Date | null {
  const clear = args.clear === "true";
  const until = args.until ?? "";
  if (clear && until) throw new CommandError("invalid", "invalid until: give until or clear, not both");
  if (clear) return null;
  if (!until) throw new CommandError("invalid", "invalid until: give until (1h, tomorrow, …) or clear");
  const d = /^(\d+)([smh])$/.exec(until.trim());
  const ms = d ? now + Number(d[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[d[2] as "s" | "m" | "h"] : Date.parse(until);
  if (!Number.isFinite(ms)) throw new CommandError("invalid", `invalid snooze time: ${until}`);
  if (ms <= now) throw new CommandError("invalid", `invalid snooze time: ${new Date(ms).toISOString()} is in the past`);
  return new Date(ms);
}

/**
 * Why stopping Claude now cuts something off (the daemon's midTurn): starting, or
 * connected and busy, or waiting on a permission request or question; "" otherwise.
 * Restarts count the threads this is set for (command.ActiveThread).
 */
function midTurn(s: { state: ThreadState; status: ThreadStatus; statusReason: string }): string {
  if (s.state === ThreadState.STARTING) return "Claude is still working";
  if (s.state !== ThreadState.CONNECTED) return "";
  if (s.status === ThreadStatus.BUSY) return "Claude is still working";
  if (s.status === ThreadStatus.NEEDS_ATTENTION && /^(permission|question):/.test(s.statusReason)) return "Claude is waiting on your answer";
  return "";
}

/** The daemon's backgroundRunning: "1 background agent and 2 shells are running". */
function backgroundRunning(agents: number, shells: number): string {
  const count = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
  const what = agents > 0 && shells > 0 ? `${count(agents, "background agent")} and ${count(shells, "shell")}` : agents > 0 ? count(agents, "background agent") : count(shells, "background shell");
  return `${what} ${agents + shells === 1 ? "is" : "are"} running`;
}

/**
 * What archiving (or snoozing) cuts off and what that ends (the daemon's
 * archiveInterrupts): mid-turn ("ends the turn"), else the background agents and shells
 * still running ("stops them"); empty strings when nothing.
 */
function archiveInterrupts(s: { state: ThreadState; status: ThreadStatus; statusReason: string }, agents: number, shells: number): { why: string; ends: string } {
  const why = midTurn(s);
  if (why) return { why, ends: "ends the turn" };
  if (s.state !== ThreadState.CONNECTED || agents + shells === 0) return { why: "", ends: "" };
  return { why: backgroundRunning(agents, shells), ends: agents + shells === 1 ? "stops it" : "stops them" };
}

/** "end" closes attached streams (after the process exits). */
export type AttachItem = AttachEventInit | "end";

interface MockTerm {
  id: string;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  title: string;
  state: TerminalState;
  exitCode: number;
  startedAt: Date;
  exitedAt: Date | null;
  altScreen: boolean;
  labels: Record<string, string>;
  kind: Kind;
  /** Raw primary-screen output, replayed as the snapshot (the ring-buffer fallback). */
  history: string;
  line: string;
  tick: number;
  attach: Hub<AttachItem>;
}

interface MockWorktree {
  path: string;
  branch: string;
  head: string;
  /** HEAD is detached (branch is ""). */
  detached?: boolean;
  isMain: boolean;
  status: {
    upstream: string;
    ahead: number;
    behind: number;
    staged: number;
    modified: number;
    untracked: number;
    dirty: boolean;
    baseRef?: string;
    baseAhead?: number;
    baseBehind?: number;
    conflicted?: number;
    /** A git operation in progress ("rebase", "merge", ...; POST /__mock/worktree/operation). */
    operation?: string;
    operationStep?: number;
    operationTotal?: number;
  };
}

interface MockRepo {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  githubSlug: string;
  /** git remotes; empty for a local-only repository (no fetch, pull, push or PRs). */
  remotes: string[];
  /** Local branches with no worktree (ListRefs lists them too). */
  branches?: string[];
  /**
   * false: a project without git (a plain folder). One synthetic main worktree with no
   * branch, head or status; no worktrees, refs, workspaces or git commands until
   * repo.git.init. Absent means git.
   */
  git?: boolean;
  worktrees: MockWorktree[];
}

/** A project without git refuses what needs git, like the daemon (FailedPrecondition). */
function requireGit(repo: MockRepo, what = "this"): void {
  if (repo.git === false) throw new CommandError("unavailable", `${repo.name} is not a git repository; ${what} needs git`);
}

export interface Invocation {
  name: string;
  context: Omit<UiContext, "$typeName" | "$unknown"> | null;
  args: Record<string, string>;
  confirmed: boolean;
  at: string;
}

/** A destructive command invoked without confirmed=true (FailedPrecondition + detail). */
export class ConfirmNeeded extends Error {
  constructor(
    readonly command: string,
    readonly title: string,
    message: string,
  ) {
    super(message);
  }
}

// In its own module so mock/thread.ts can throw it without importing the world.
export { CommandError };

// Repo paths under the fake home (mock/filesystem.ts lists the same tree).
const CF = `${HOME}/src/code-foundry`;
const CFW = `${HOME}/src/code-foundry.worktrees`;
const GP = `${HOME}/src/ghostty-playground`;
const SK = `${HOME}/src/sketches`;
const WR = `${HOME}/Documents/writing`;
const enc = new TextEncoder();

/** How long a new shell takes to print its prompt before terminal.new --run types into it. */
const RUN_PROMPT_MS = 150;

/**
 * terminal.new --run's value as typed keys, like the daemon for a shell without bracketed
 * paste (commands_terminal.go runInput, runKeys; the mock's shells never turn mode 2004
 * on): line ends become Return, one Return ends it, trailing blank lines go, control
 * characters other than tab and newline are refused. "" when blank.
 */
function runKeys(run: string): string {
  const s = run.replace(/\r\n/g, "\n").replace(/[\n\t ]+$/, "");
  if (s.trim() === "") return "";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) throw new CommandError("invalid", "run: the command has a control character");
  return `${s.replace(/\n/g, "\r")}\r`;
}

/** thread.new's `permission` arg values. */
const permissionModes: Record<string, PermissionMode> = {
  supervised: PermissionMode.SUPERVISED,
  "accept-edits": PermissionMode.ACCEPT_EDITS,
  auto: PermissionMode.AUTO,
};

/** "Add a dark mode toggle!" -> "Add a dark mode" (what the daemon's title naming stands in for). */
export function promptTitle(prompt: string): string {
  const words = prompt.replace(/[^A-Za-z0-9']+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4);
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** "Add a dark mode" -> "add-a-dark-mode": the daemon's slugify, for cf/<slug> branches. */
export function promptSlug(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4).join("-");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A typical detector reason for a status (captured strings; see src/lib/thread.test.ts). */
function defaultReason(status: ThreadStatus): string {
  switch (status) {
    case ThreadStatus.BUSY:
      return "working";
    case ThreadStatus.IDLE:
      return "at prompt";
    case ThreadStatus.NEEDS_ATTENTION:
      return "permission: Do you want to proceed?";
    case ThreadStatus.ERROR:
      return "interrupted";
    default:
      return "";
  }
}
const HISTORY_CAP = 256 * 1024;

function clean(over: Partial<MockWorktree["status"]> = {}): MockWorktree["status"] {
  return { upstream: "origin/main", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, baseRef: "origin/main", baseAhead: 0, baseBehind: 0, ...over };
}

/** Where the mock daemon makes worktrees (the daemon's repo store WorktreeRoot). */
const WORKTREE_ROOT = `${HOME}/.code-foundry/worktrees`;

/** Made by the app: strictly inside its worktrees directory (the daemon's Worktree.Managed). */
function managed(w: MockWorktree): boolean {
  return w.path.startsWith(`${WORKTREE_ROOT}/`);
}

/** The daemon's repo.MergedCleanReason == "": not main, made by the app, on a branch, nothing uncommitted, every commit in baseRef. */
function mergedClean(w: MockWorktree): boolean {
  const st = w.status;
  return !w.isMain && managed(w) && !w.detached && w.branch !== "" && !st.dirty && st.staged + st.modified + st.untracked === 0 && Boolean(st.baseRef) && (st.baseAhead ?? 0) === 0;
}

function initialRepos(): MockRepo[] {
  return [
    {
      id: "repo-cf",
      path: CF,
      name: "code-foundry",
      defaultBranch: "main",
      githubSlug: "alexwaumann/code-foundry",
      remotes: ["origin"],
      worktrees: [
        { path: CF, branch: "main", head: "3c3c4651", isMain: true, status: clean() },
        { path: `${CFW}/feat-sidebar`, branch: "feat/sidebar", head: "9a8b7c6d", isMain: false, status: clean({ upstream: "origin/feat/sidebar", ahead: 2, modified: 3, untracked: 1, dirty: true, baseAhead: 3, baseBehind: 1 }) },
        { path: `${CFW}/fix-resize`, branch: "fix/resize", head: "1f2e3d4c", isMain: false, status: clean({ upstream: "origin/fix/resize", behind: 1, baseAhead: 12 }) },
      ],
    },
    {
      id: "repo-gp",
      path: GP,
      name: "ghostty-playground",
      defaultBranch: "main",
      githubSlug: "alexwaumann/ghostty-playground",
      remotes: ["origin"],
      worktrees: [{ path: GP, branch: "main", head: "77aa55cc", isMain: true, status: clean({ staged: 1, dirty: true }) }],
    },
    {
      id: "repo-dot",
      path: `${HOME}/dotfiles`,
      name: "dotfiles",
      defaultBranch: "main",
      githubSlug: "",
      // A remote that is not GitHub: fetch/pull/push work, PRs do not.
      remotes: ["origin"],
      worktrees: [{ path: `${HOME}/dotfiles`, branch: "main", head: "0badc0de", isMain: true, status: clean({ upstream: "", baseRef: "" }) }],
    },
    {
      // Local only: no remote at all. Refs are local branches; the default base is "main".
      id: "repo-sk",
      path: SK,
      name: "sketches",
      defaultBranch: "main",
      githubSlug: "",
      remotes: [],
      branches: ["experiment/shaders"],
      worktrees: [{ path: SK, branch: "main", head: "5ca1ab1e", isMain: true, status: clean({ upstream: "", baseRef: "" }) }],
    },
    {
      // Not a git repository: a plain folder. Its one checkout is the folder itself;
      // repo.git.init makes it a git repository on main with an empty first commit.
      id: "repo-wr",
      path: WR,
      name: "writing",
      defaultBranch: "",
      githubSlug: "",
      remotes: [],
      git: false,
      worktrees: [{ path: WR, branch: "", head: "", isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false } }],
    },
  ];
}

/**
 * thread.new's first message: its prompt (and attachments), sent once the thread has
 * connected, with the composer's text for display. null without either.
 */
function firstMessageOf(args: Record<string, string>): MockThread["firstMessage"] {
  const text = (args.prompt ?? "").trim();
  const attachments = (args.attachments ?? "").split(",").filter(Boolean);
  return text || attachments.length > 0 ? { text, attachments, composerText: args["composer-prompt"] ?? "" } : null;
}

/**
 * The default world's thread histories (MockThreadLogs.seed), so every thread's timeline has
 * something to show: s-1 is mid-reply, s-2 waits on a Bash permission (its status reason
 * names it), s-3 finished before it exited, s-4 crashed mid-turn, s-6 finished before its
 * close. s-5 is still starting: nothing yet.
 */
const SEEDS: Readonly<Record<string, SeedHistory | undefined>> = {
  "s-1": {
    prompt: "Refactor the sidebar tree into a virtualized list.",
    intro: "I'll start by reading the current sidebar and the tree builder.",
    command: "rg -n useVirtualizer gui/frontend/src",
    output: "gui/frontend/src/components/sidebar/Sidebar.tsx:12:import { useVirtualizer } from \"@tanstack/react-virtual\";",
    reply: "The tree now flattens into rows; only the visible rows render. Moving the row builder into `lib/tree.ts`",
    minutesAgo: 6,
    end: "working",
  },
  "s-2": {
    prompt: "Port the grid renderer to libghostty-vt.",
    intro: "The bindings are in place; building the playground to check the renderer links.",
    command: "zig version",
    output: "0.15.1",
    reply: "zig build -Doptimize=ReleaseFast",
    minutesAgo: 4,
    end: "permission",
  },
  "s-3": {
    prompt: "Fix the resize race in the terminal actor.",
    intro: "Reproducing it with the race detector first.",
    command: "go test -race ./internal/store/terminal/",
    output: "ok  \tgithub.com/alexwaumann/code-foundry/internal/store/terminal\t1.412s",
    reply: "Fixed: the actor applies a resize only after the pending writes drain. The race test passes.",
    minutesAgo: 100,
    end: "done",
  },
  "s-4": {
    prompt: "Investigate the flaky e2e run on CI.",
    intro: "Looking at the last failed run's logs.",
    command: "gh run view --log-failed",
    output: "e2e/app.spec.ts:120 › connection budget: timed out",
    reply: "",
    minutesAgo: 18,
    end: "cut",
  },
  "s-6": {
    prompt: "Tidy my zshrc: drop the unused plugins.",
    intro: "Checking which plugins are loaded.",
    command: "grep -n plugins ~/.zshrc",
    output: "12:plugins=(git z fzf docker kubectl)",
    reply: "Removed docker and kubectl from the plugin list; nothing else references them.",
    minutesAgo: 61,
    end: "done",
  },
};

export class World {
  readonly startedAt = Date.now();
  terms = new Map<string, MockTerm>();
  repos = new Map<string, MockRepo>();
  threads = new Map<string, MockThread>();
  workspaces = new Map<string, MockWorkspace>();
  /** EventService: every hub below tees into this one, so its order is publish order. */
  readonly events = new Hub<{ source: EventSource; event: EventInit }>();
  readonly termEvents = new Hub<TerminalEventInit>((v) => this.events.publish({ source: EventSource.TERMINAL, event: { event: { case: "terminal", value: v } } }));
  readonly repoEvents = new Hub<RepoEventInit>((v) => this.events.publish({ source: EventSource.REPO, event: { event: { case: "repo", value: v } } }));
  readonly workspaceEvents = new Hub<WorkspaceEventInit>((v) => this.events.publish({ source: EventSource.WORKSPACE, event: { event: { case: "workspace", value: v } } }));
  readonly threadListEvents = new Hub<ThreadListEventInit>((v) => this.events.publish({ source: EventSource.THREAD_LIST, event: { event: { case: "threadList", value: v } } }));
  readonly intents = new Hub<UiIntentInit>((v) => this.events.publish({ source: EventSource.UI, event: { event: { case: "ui", value: v } } }));
  readonly gitopsEvents = new Hub<GitOpsEventInit>((v) => this.events.publish({ source: EventSource.GITOPS, event: { event: { case: "gitops", value: v } } }));
  /** Threads' conversations (mock/thread.ts); the EventService thread source carries their pending requests. */
  readonly logs = new MockThreadLogs(
    {
      worktreeOf: (id) => this.thread(id).worktreePath,
      modelOf: (id) => this.thread(id).model,
      isConnected: (id) => this.thread(id).state === ThreadState.CONNECTED,
      start: (id, ready) => {
        this.startThread(id, ready);
      },
      setStatus: (id, status, reason) => {
        const s = this.thread(id);
        this.setStatus(s, status, reason);
        s.lastActivityAt = new Date();
        this.publishThread(s);
      },
      setModel: (id, model) => {
        const s = this.thread(id);
        s.model = model;
        this.publishThread(s);
      },
      setPermission: (id, permission) => {
        const s = this.thread(id);
        s.permissionMode = permissionModes[permission] ?? s.permissionMode;
        this.publishThread(s);
      },
      setEffort: (id, effort, pending) => {
        const s = this.thread(id);
        s.effort = effort;
        s.effortPending = pending;
        this.publishThread(s);
      },
      statusOf: (id) => this.thread(id).status,
      recordResult: (id, model) => {
        const s = this.thread(id);
        recordResult(s, model);
        this.publishThread(s);
      },
      agentsChanged: (id) => {
        const s = this.threads.get(id);
        if (s) this.publishThread(s);
      },
    },
    (ev) => this.events.publish({ source: EventSource.THREAD, event: { event: { case: "thread", value: ev } } }),
  );
  /** git.*, pr.*, worktree.open.editor, worktree.reveal, view.open.url (mock/gitops.ts). */
  readonly gitops = new MockGitOps((e) => this.gitopsEvents.publish(e));
  readonly settings = new MockSettings(
    () => this.registry().map((e) => e.cmd),
    (snap) => {
      this.events.publish({ source: EventSource.SETTINGS, event: { event: { case: "settings", value: { event: { case: "snapshot", value: snap } } } } });
      // Like the daemon: a new cache TTL moves every expiry, so those threads are republished.
      for (const s of this.threads.values()) if (s.lastResultAt) this.publishThread(s);
    },
  );
  /** Actions and their runs (mock/actions.ts); terminal runs are kind=action terminals here. */
  readonly actions = new MockActions({
    publish: (v) => this.events.publish({ source: EventSource.ACTION, event: { event: { case: "action", value: v } } }),
    repos: () => [...this.repos.values()].map((r) => ({ id: r.id, name: r.name, worktrees: r.worktrees.map((w) => w.path) })),
    thread: (id) => {
      const s = this.threads.get(id);
      return s && { repoId: s.repoId, worktreePath: s.worktreePath };
    },
    startTerminal: (argv, cwd, labels) => this.create(argv, cwd, labels, "action").id,
    write: (id, text) => {
      const t = this.terms.get(id);
      if (t?.state === TerminalState.RUNNING) this.output(t, text);
    },
    exit: (id, code) => {
      if (this.terms.has(id)) this.kill(id, code);
    },
  });
  /** UpdateService (Phase 3d): publishes into the events hub as the update source. */
  readonly update = new MockUpdater(
    (v) => this.events.publish({ source: EventSource.UPDATE, event: { event: { case: "update", value: v } } }),
    () => this.restartCost(),
  );

  /** The daemon's command.RestartCostOf over the threads (ActiveThread: archiveInterrupts). */
  private restartCost(): RestartCost {
    const c: RestartCost = { threads: 0, midTurn: 0, agents: 0, shells: 0 };
    for (const s of this.threads.values()) {
      if (this.interrupts(s).why === "") continue;
      c.threads++;
      if (midTurn(s) !== "") c.midTurn++;
      if (s.state !== ThreadState.CONNECTED) continue;
      c.agents += agentCounts(this.logs.agentRunsOf(s.id)).backgroundAgentsRunning;
      c.shells += this.logs.shellsOf(s.id);
    }
    return c;
  }
  /** Phase 3a GitHub dashboards/activity and worktree details (mock/github.ts). */
  readonly gh = new GhWorld(
    (e) => this.events.publish(ghEvent(e)),
    (e) => this.repoEvents.publish(e),
  );
  /** EventService watchers that include UI intents (they count toward Emit's `delivered`). */
  uiEventWatchers = 0;
  /** ThreadService.StageAttachment uploads, by returned path. */
  attachments = new Map<string, { name: string; mimeType: string; size: number; pages: number }>();
  /** How long thread.new takes to create a worktree (ms). */
  worktreeDelayMs = 700;
  /** terminal.new: how long it takes (ms), and whether its next run fails (the reason). POST /__mock/terminal/new. */
  terminalNewDelayMs = 0;
  terminalNewFail: string | null = null;
  /** Bumped by reset(), so a thread.new still sleeping from before a reset does nothing. */
  private generation = 0;
  invocations: Invocation[] = [];
  writes: { id: string; data: string }[] = [];
  resizes: { id: string; cols: number; rows: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seconds = 0;
  private nextId = 1;

  constructor() {
    this.reset();
  }

  reset(): void {
    for (const t of this.terms.values()) t.attach.publish("end");
    this.terms.clear();
    this.repos.clear();
    this.workspaces.clear();
    this.invocations = [];
    this.attachments.clear();
    this.logs.reset();
    this.worktreeDelayMs = 700;
    this.terminalNewDelayMs = 0;
    this.terminalNewFail = null;
    this.generation++;
    this.gitops.reset();
    this.settings.reset();
    this.writes = [];
    this.resizes = [];
    this.nextId = 1;
    for (const r of initialRepos()) this.repos.set(r.id, r);
    this.gh.reset();
    const started = new Date(Date.now() - 42 * 60_000);
    // A shell terminal.new started on the Projects page for feat/sidebar (worktree-owned).
    this.addTerm({ id: "t-top", argv: ["top"], cwd: `${CFW}/feat-sidebar`, title: "", kind: "top", labels: shellLabels("", "repo-cf", `${CFW}/feat-sidebar`), startedAt: started });
    // A shell terminal.new started in thread s-1 (thread-owned: s-1's bottom panel).
    this.addTerm({ id: "t-s1-shell", argv: ["/bin/zsh", "-l"], cwd: CF, title: "", kind: "shell", labels: shellLabels("s-1", "repo-cf", CF), startedAt: started });
    // Threads in every state, each with a short history (SEEDS).
    this.threads.clear();
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    this.addThread({ id: "s-1", repoId: "repo-cf", worktreePath: CF, name: "Refactor sidebar tree", model: "claude-opus-4-8[1m]", effort: "high", status: ThreadStatus.BUSY, statusReason: "working: Refactor sidebar tree", createdAt: ago(42), usage: sampleUsage() });
    this.addThread({ id: "s-2", repoId: "repo-gp", worktreePath: GP, name: "Port renderer", model: "claude-sonnet-5[1m]", effort: "", status: ThreadStatus.NEEDS_ATTENTION, statusReason: `permission: Bash ${SEEDS["s-2"]?.reply ?? ""}`, statusChangedAt: ago(3), createdAt: ago(40) });
    this.addThread({ id: "s-3", repoId: "repo-cf", worktreePath: `${CFW}/fix-resize`, name: "Fix resize race", model: "claude-opus-4-8[1m]", effort: "medium", state: ThreadState.DISCONNECTED, disconnectReason: "idle", createdAt: ago(300), lastActivityAt: ago(95), usage: pageUsage("s-3") });
    this.addThread({ id: "s-4", repoId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Investigate flaky e2e", model: "claude-4.5-haiku[1m]", effort: "", state: ThreadState.DISCONNECTED, disconnectReason: "crashed", exitCode: 139, createdAt: ago(200), lastActivityAt: ago(17), usage: pageUsage("s-4") });
    this.addThread({ id: "s-5", repoId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Write thread docs", model: "claude-opus-4-8[1m]", effort: "low", state: ThreadState.STARTING, settleIn: 8, createdAt: ago(0) });
    this.addThread({ id: "s-6", repoId: "repo-dot", worktreePath: `${HOME}/dotfiles`, name: "Tidy zshrc", model: "claude-sonnet-5[1m]", effort: "", state: ThreadState.CLOSING, settleIn: 8, createdAt: ago(60) });
    // Archived 90 min ago (the sidebar's Archived section, collapsed by default).
    this.addThread({ id: "s-7", repoId: "repo-cf", worktreePath: CF, name: "Spike a canvas sidebar", model: "claude-sonnet-5[1m]", effort: "", state: ThreadState.DISCONNECTED, disconnectReason: "closed", status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", statusChangedAt: ago(95), createdAt: ago(600), lastActivityAt: ago(95), archivedAt: ago(90) });
    // Snoozed (the sidebar's Snoozed section, collapsed by default): s-8 wakes in 2.5 h (a
    // finished turn, so it does not count as attention while snoozed), s-9 in 4 days.
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    this.addThread({ id: "s-8", repoId: "repo-cf", worktreePath: CF, name: "Refactor the gh poller", model: "claude-sonnet-5[1m]", effort: "", state: ThreadState.DISCONNECTED, disconnectReason: "closed", status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", statusChangedAt: ago(30), createdAt: ago(500), lastActivityAt: ago(30), snoozedUntil: later(150) });
    this.addThread({ id: "s-9", repoId: "repo-gp", worktreePath: GP, name: "Bump wails to v3.1", model: "claude-opus-4-8[1m]", effort: "medium", state: ThreadState.DISCONNECTED, disconnectReason: "closed", createdAt: ago(450), lastActivityAt: ago(20), snoozedUntil: later(4 * 24 * 60 + 60) });
    for (const [id, h] of Object.entries(SEEDS)) if (h) this.logs.seed(id, h);
    // Republish so connected watchers converge on the reset state.
    for (const t of this.terms.values()) this.termEvents.publish({ event: { case: "updated", value: this.terminalMsg(t) } });
    for (const r of this.repos.values()) this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(r) } });
    this.workspaceEvents.publish(this.workspaceSnapshot());
    this.threadListEvents.publish(this.threadListSnapshot());
    this.actions.reset();
    this.update.reset();
  }

  // ---- Workspaces ---------------------------------------------------------------

  workspaceMsg(w: MockWorkspace): WorkspaceInit {
    return { id: w.id, name: w.name, branch: w.branch, members: w.members.map((m) => ({ ...m })), createdAt: timestampFromDate(w.createdAt) };
  }

  workspaceSnapshot(): WorkspaceEventInit {
    const list = [...this.workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { event: { case: "snapshot", value: { workspaces: list.map((w) => this.workspaceMsg(w)) } } };
  }

  /** A repo by id or (unique) name, like the daemon's repo refs. */
  private repoRef(ref: string): MockRepo {
    const r = this.repos.get(ref) ?? [...this.repos.values()].find((x) => x.name === ref);
    if (!r) throw new CommandError("notfound", `repository ${ref} not found`);
    return r;
  }

  /** A workspace member's repo: like repoRef, and never a project without git. */
  private memberRepoRef(ref: string): MockRepo {
    const r = this.repoRef(ref);
    if (r.git === false) throw new CommandError("unavailable", `${r.name} is not a git repository; workspaces need git in every project`);
    return r;
  }

  /**
   * A worktree on `branch` whose work is in origin/<default> and that has no changes
   * (cleanable unless something holds it). `path`: put it there instead, e.g. outside the
   * app's worktrees directory, as another tool would (then it is never cleanable).
   */
  addMergedWorktree(repoRef: string, branch: string, path = ""): MockWorktree {
    const repo = this.repoRef(repoRef);
    const w = this.addWorktree(repo, branch, `origin/${repo.defaultBranch || "main"}`);
    if (path) {
      w.path = path;
      this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
    }
    return w;
  }

  /** Why the daemon's cleanupHold keeps a worktree: a thread on it, a running terminal, a workspace; "" for nothing. */
  private cleanupHold(path: string): string {
    const thread = this.threadsIn([path])[0];
    if (thread) return thread.name ? `thread ${thread.name} is on it` : "a thread is on it";
    for (const t of this.terms.values()) {
      if (t.state === TerminalState.RUNNING && (t.labels[LABEL_WORKTREE] === path || t.cwd === path || t.cwd.startsWith(`${path}/`))) return "a terminal is open in it";
    }
    for (const ws of this.workspaces.values()) if (ws.members.some((m) => m.worktreePath === path)) return `member of workspace ${ws.name}`;
    return "";
  }

  /** RepoService.CleanupWorktrees: what repo.worktree.cleanup removes (dry: only says so) and what it keeps, with why. */
  cleanupWorktrees(repoRef: string, path: string, dry: boolean): { removed: MockWorktree[]; skipped: { w: MockWorktree; reason: string }[] } {
    const repo = this.repoRef(repoRef);
    requireGit(repo, "a cleanup");
    const candidates = path ? repo.worktrees.filter((w) => w.path === path) : repo.worktrees.filter((w) => !w.isMain);
    if (path && candidates.length === 0) throw new CommandError("notfound", `worktree ${path} in repo ${repo.name}`);
    const out: { removed: MockWorktree[]; skipped: { w: MockWorktree; reason: string }[] } = { removed: [], skipped: [] };
    for (const w of candidates) {
      const reason = !mergedClean(w) ? (w.isMain ? "main worktree" : !managed(w) ? "not a Code Foundry worktree" : w.status.dirty ? "uncommitted changes" : !w.status.baseRef ? "no remote default branch to compare with" : `${String(w.status.baseAhead ?? 0)} commits not in ${w.status.baseRef}`) : this.cleanupHold(w.path);
      if (reason) {
        out.skipped.push({ w, reason });
        continue;
      }
      if (!dry) this.dropWorktree(w.path);
      out.removed.push(w);
    }
    return out;
  }

  /** A new worktree on `branch` in `repo` (published), where the daemon would put it. */
  private addWorktree(repo: MockRepo, branch: string, baseRef: string): MockWorktree {
    requireGit(repo, "a new worktree");
    const w: MockWorktree = {
      path: `${HOME}/.code-foundry/worktrees/${repo.githubSlug || `_local/${repo.name}`}/${branch.replace(/\//g, "-")}`,
      branch,
      head: "c0ffee00",
      isMain: false,
      status: clean({ upstream: "", baseRef }),
    };
    repo.worktrees.push(w);
    this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
    return w;
  }

  /**
   * workspace.new: a worktree on cf/<name> (or `branch`) in every repo ("<repo>[:<base>]"
   * refs, by id or name), then the workspace. Test control: POST /__mock/workspace.
   */
  addWorkspace(name: string, refs: readonly string[], branch = `cf/${name}`): MockWorkspace {
    if ([...this.workspaces.values()].some((w) => w.name === name)) throw new CommandError("unavailable", `a workspace named "${name}" exists`);
    if (refs.length === 0) throw new CommandError("invalid", "a workspace needs at least one repository");
    const specs = refs.map((ref) => {
      const [id = "", base = ""] = ref.split(":");
      const repo = this.memberRepoRef(id.trim());
      return { repo, base: base.trim() || (repo.remotes.length > 0 ? `origin/${repo.defaultBranch}` : repo.defaultBranch) };
    });
    const w: MockWorkspace = {
      id: `w-${String(this.workspaces.size + 1).padStart(12, "0")}`,
      name,
      branch,
      members: specs.map(({ repo, base }) => ({ repoId: repo.id, worktreePath: this.addWorktree(repo, branch, base).path })),
      createdAt: new Date(),
    };
    this.workspaces.set(w.id, w);
    this.workspaceEvents.publish({ event: { case: "updated", value: this.workspaceMsg(w) } });
    return w;
  }

  private workspaceRef(ref: string): MockWorkspace {
    const w = this.workspaces.get(ref) ?? [...this.workspaces.values()].find((x) => x.name === ref);
    if (!w) throw new CommandError("notfound", `workspace ${ref} not found`);
    return w;
  }

  /**
   * Test control: workspace `name` over code-foundry, ghostty-playground and dotfiles with
   * mixed member state: code-foundry's member has an open pull request with failing CI,
   * ghostty-playground's is 2 commits ahead of its upstream, and dotfiles' (local only) has
   * uncommitted changes. POST /__mock/workspace-mixed.
   */
  addMixedWorkspace(name: string): MockWorkspace {
    const ws = this.addWorkspace(name, ["repo-cf", "repo-gp", "repo-dot"]);
    const set = (repoId: string, status: Partial<MockWorktree["status"]>) => {
      const repo = this.repos.get(repoId);
      const path = ws.members.find((m) => m.repoId === repoId)?.worktreePath;
      const w = repo?.worktrees.find((x) => x.path === path);
      if (!repo || !w) return;
      w.status = { ...w.status, ...status };
      this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
    };
    set("repo-cf", { upstream: `origin/${ws.branch}` });
    set("repo-gp", { upstream: `origin/${ws.branch}`, ahead: 2, baseAhead: 2 });
    set("repo-dot", { modified: 2, untracked: 1, dirty: true });
    this.gh.addBranchPullRequest("alexwaumann/code-foundry", ws.branch, 151, `${name}: one change across three projects`);
    return ws;
  }

  /** Test control: a fresh install, with no projects, workspaces, threads or terminals. POST /__mock/empty. */
  empty(): void {
    for (const [id, t] of this.terms) {
      t.attach.publish("end");
      this.termEvents.publish({ event: { case: "removedId", value: id } });
    }
    this.terms.clear();
    this.threads.clear();
    this.workspaces.clear();
    for (const id of [...this.repos.keys()]) {
      this.actions.removeRepo(id);
      this.repoEvents.publish({ event: { case: "repoRemovedId", value: id } });
    }
    this.repos.clear();
    this.workspaceEvents.publish(this.workspaceSnapshot());
    this.threadListEvents.publish(this.threadListSnapshot());
  }

  /** Test control: `count` connected project threads with `status` in `repo`'s main worktree. POST /__mock/threads. */
  addThreads(repo: string, count: number, status: ThreadStatus, prefix: string): MockThread[] {
    const r = this.repoRef(repo);
    const path = r.worktrees.find((w) => w.isMain)?.path ?? r.path;
    const out: MockThread[] = [];
    for (let i = 1; i <= count; i++) {
      const s = this.addThread({ id: `s-t-${String(this.nextId++)}`, repoId: r.id, worktreePath: path, name: `${prefix} ${String(i)}`, model: "claude-4.5-haiku[1m]", effort: "", status, createdAt: new Date() });
      this.publishThread(s);
      out.push(s);
    }
    return out;
  }

  /**
   * Scenario: one thread per status kind the sidebar distinguishes (lib/thread statusKind),
   * with captured reasons and staggered statusChangedAt. POST /__mock/status-kinds, or
   * MOCK_SCENARIO=status-kinds. Idempotent. Not in the default world, whose rows e2e pins.
   */
  addStatusKinds(): string[] {
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const A = ThreadStatus.NEEDS_ATTENTION;
    const D = ThreadState.DISCONNECTED;
    type Kind = Partial<MockThread> & Pick<MockThread, "id" | "name" | "status" | "statusReason"> & { min: number };
    const kinds: Kind[] = [
      { id: "s-k-approval", name: "Run the migration script", status: A, statusReason: "waiting for approval: Bash", min: 2 },
      { id: "s-k-question", name: "Pick a color palette", status: A, statusReason: "question: Which color do you prefer?", min: 6 },
      { id: "s-k-plan", name: "Plan the settings page", status: A, statusReason: "plan: Claude has written up a plan and is ready to execute. Would you like to proceed?", min: 1 },
      { id: "s-k-finished", name: "Summarize the changelog", status: A, statusReason: "finished", min: 12 },
      { id: "s-k-error", name: "Try the new model", status: A, statusReason: "error: model_not_found", min: 20 },
      { id: "s-k-busy", name: "Index the docs", status: ThreadStatus.BUSY, statusReason: "running Bash", min: 0.5 },
      { id: "s-k-idle", name: "Review lint rules", status: ThreadStatus.IDLE, statusReason: "at prompt", min: 50 },
      { id: "s-k-interrupted", name: "Migrate the config loader", status: ThreadStatus.ERROR, statusReason: "interrupted", min: 35, state: D, disconnectReason: "daemon stopped" },
      { id: "s-k-asked-before-restart", name: "Choose sidebar density", status: A, statusReason: "question: Which density should the sidebar use?", min: 90, state: D, disconnectReason: "daemon restarted" },
    ];
    const out: string[] = [];
    for (const { min, ...k } of kinds) {
      out.push(k.id);
      if (this.threads.has(k.id)) continue;
      const s = this.addThread({ repoId: "repo-cf", worktreePath: CF, model: "claude-4.5-haiku[1m]", effort: "medium", createdAt: ago(min + 5), lastActivityAt: ago(min), statusChangedAt: ago(min), ...k });
      this.publishThread(s);
    }
    return out;
  }

  /** Test control: a connected thread owned by the workspace, running in `repo`'s member (else the first). */
  addWorkspaceThread(workspace: string, repo: string, name: string, status: ThreadStatus = ThreadStatus.IDLE): MockThread {
    const ws = this.workspaceRef(workspace);
    const member = repo ? ws.members.find((m) => m.repoId === this.repoRef(repo).id) : ws.members[0];
    if (!member) throw new CommandError("unavailable", `repo ${repo} is not a member of workspace ${ws.name}`);
    const s = this.addThread({ id: `s-ws-${String(this.nextId++)}`, repoId: member.repoId, worktreePath: member.worktreePath, name, model: "claude-4.5-haiku[1m]", effort: "", workspaceId: ws.id, status, createdAt: new Date() });
    this.publishThread(s);
    return s;
  }

  /**
   * thread.run-in: a stopped thread moves at once; a running one gets the target as
   * pendingWorktreePath and moves ~2s after it stops being busy (MockThread.moveIn).
   * Asking for the current member cancels a queued move.
   */
  runIn(s: MockThread, repoRef: string, worktree: string): MockThread {
    if (!s.workspaceId) throw new CommandError("unavailable", `thread ${s.id} does not belong to a workspace`);
    const ws = this.workspaceRef(s.workspaceId);
    const member = worktree ? ws.members.find((m) => m.worktreePath === worktree) : ws.members.find((m) => m.repoId === this.repoRef(repoRef).id);
    if (!member) throw new CommandError("unavailable", `${repoRef || worktree} is not a member of workspace ${ws.name}`);
    if (s.state === ThreadState.CLOSING) throw new CommandError("unavailable", `thread ${s.id} is closing`);
    if (s.state === ThreadState.DISCONNECTED || member.worktreePath === s.worktreePath) {
      s.pendingWorktreePath = "";
      if (member.worktreePath !== s.worktreePath) {
        s.worktreePath = member.worktreePath;
        s.repoId = member.repoId;
      }
    } else {
      s.pendingWorktreePath = member.worktreePath;
      s.moveIn = 2;
    }
    this.publishThread(s);
    return s;
  }

  private applyMove(s: MockThread): void {
    const path = s.pendingWorktreePath;
    const ws = this.workspaces.get(s.workspaceId);
    const member = ws?.members.find((m) => m.worktreePath === path);
    s.pendingWorktreePath = "";
    if (member) {
      s.worktreePath = member.worktreePath;
      s.repoId = member.repoId;
    }
    this.publishThread(s);
  }

  /** workspace.add-repo: a worktree on the workspace branch in another repo. */
  addWorkspaceRepo(workspace: string, repoRef: string, base: string): MockWorkspace {
    const ws = this.workspaceRef(workspace);
    const repo = this.memberRepoRef(repoRef);
    if (ws.members.some((m) => m.repoId === repo.id)) throw new CommandError("unavailable", `${repo.name} is already a member of workspace ${ws.name}`);
    const w = this.addWorktree(repo, ws.branch, base || (repo.remotes.length > 0 ? `origin/${repo.defaultBranch}` : repo.defaultBranch));
    ws.members.push({ repoId: repo.id, worktreePath: w.path });
    this.workspaceEvents.publish({ event: { case: "updated", value: this.workspaceMsg(ws) } });
    return ws;
  }

  /** Live threads whose cwd is in one of these worktrees (the daemon's removal guard). */
  private threadsIn(paths: readonly string[]): MockThread[] {
    // The daemon's worktreeThreads: every thread but an archived one, whatever its state.
    return [...this.threads.values()].filter((s) => s.archivedAt === null && paths.some((p) => s.worktreePath === p || s.worktreePath.startsWith(`${p}/`)));
  }

  private dropWorktree(path: string): void {
    for (const repo of this.repos.values()) {
      if (!repo.worktrees.some((w) => w.path === path)) continue;
      repo.worktrees = repo.worktrees.filter((w) => w.path !== path);
      this.repoEvents.publish({ event: { case: "worktreeRemoved", value: { repoId: repo.id, path } } });
    }
    this.closeShells((l) => l[LABEL_WORKTREE] === path);
    this.actions.stopBackground((r) => r.worktreePath === path);
  }

  /** workspace.remove-repo: refused while a thread's Claude runs there or with changes (unless force). */
  removeWorkspaceRepo(workspace: string, repoRef: string, force: boolean): MockWorkspace {
    const ws = this.workspaceRef(workspace);
    const member = ws.members.find((m) => m.worktreePath === repoRef) ?? ws.members.find((m) => m.repoId === this.repoRef(repoRef).id);
    if (!member) throw new CommandError("unavailable", `${repoRef} is not a member of workspace ${ws.name}`);
    const busy = this.threadsIn([member.worktreePath])[0];
    if (busy) throw new CommandError("unavailable", `thread ${busy.name || busy.id} (${busy.id}) is on ${member.worktreePath}; archive it first`);
    const wt = [...this.repos.values()].flatMap((r) => r.worktrees).find((w) => w.path === member.worktreePath);
    if (wt?.status.dirty && !force) throw new CommandError("unavailable", `remove worktree ${member.worktreePath}: it has uncommitted changes; use --force`);
    this.dropWorktree(member.worktreePath);
    ws.members = ws.members.filter((m) => m !== member);
    this.workspaceEvents.publish({ event: { case: "updated", value: this.workspaceMsg(ws) } });
    return ws;
  }

  /** workspace.remove: every member worktree, then the workspace. */
  removeWorkspace(workspace: string, force: boolean): void {
    const ws = this.workspaceRef(workspace);
    const busy = this.threadsIn(ws.members.map((m) => m.worktreePath))[0];
    if (busy) throw new CommandError("unavailable", `thread ${busy.name || busy.id} (${busy.id}) is on ${busy.worktreePath}; archive them first`);
    const paths = new Set(ws.members.map((m) => m.worktreePath));
    const dirty = [...this.repos.values()].flatMap((r) => r.worktrees).find((w) => paths.has(w.path) && w.status.dirty);
    if (dirty && !force) throw new CommandError("unavailable", `worktree ${dirty.path} has uncommitted changes; use --force`);
    for (const m of ws.members) this.dropWorktree(m.worktreePath);
    this.workspaces.delete(ws.id);
    this.workspaceEvents.publish({ event: { case: "removedId", value: ws.id } });
  }

  // ---- Threads -----------------------------------------------------------------

  private addThread(o: Partial<MockThread> & Pick<MockThread, "id" | "repoId" | "worktreePath" | "name" | "model" | "effort">): MockThread {
    const state = o.state ?? ThreadState.CONNECTED;
    const status = o.status ?? ThreadStatus.IDLE;
    const s: MockThread = {
      claudeSessionId: `cl-${o.id}`,
      autoNamed: true,
      status,
      statusReason: o.statusReason ?? defaultReason(status),
      statusChangedAt: o.statusChangedAt ?? o.lastActivityAt ?? new Date(),
      createdAt: new Date(),
      lastActivityAt: new Date(),
      exitCode: 0,
      disconnectReason: "",
      lastError: "",
      parentId: "",
      permissionMode: PermissionMode.AUTO,
      baseRef: "",
      createdWorktree: false,
      workspaceId: "",
      pendingWorktreePath: "",
      pinned: false,
      archivedAt: null,
      snoozedUntil: null,
      effortPending: false,
      firstMessage: null,
      onReady: [],
      linkedPullRequests: [],
      usage: [],
      contextTokens: 0,
      contextModel: "",
      lastResultAt: null,
      retry: null,
      moveIn: 0,
      settleIn: 0,
      nameIn: 0,
      pendingName: "",
      held: false,
      ...o,
      state,
    };
    this.threads.set(s.id, s);
    return s;
  }

  threadMsg(s: MockThread): ThreadInit {
    return {
      id: s.id,
      claudeSessionId: s.claudeSessionId,
      repoId: s.repoId,
      worktreePath: s.worktreePath,
      name: s.name,
      autoNamed: s.autoNamed,
      model: s.model,
      effort: s.effort,
      state: s.state,
      status: s.status,
      statusReason: s.statusReason,
      statusChangedAt: timestampFromDate(s.statusChangedAt),
      createdAt: timestampFromDate(s.createdAt),
      lastActivityAt: timestampFromDate(s.lastActivityAt),
      exitCode: s.exitCode,
      disconnectReason: s.disconnectReason,
      lastError: s.lastError,
      parentId: s.parentId,
      permissionMode: s.permissionMode,
      baseRef: s.baseRef,
      createdWorktree: s.createdWorktree,
      workspaceId: s.workspaceId,
      pendingWorktreePath: s.pendingWorktreePath,
      pinned: s.pinned,
      ...(s.archivedAt ? { archivedAt: timestampFromDate(s.archivedAt) } : {}),
      ...(s.snoozedUntil ? { snoozedUntil: timestampFromDate(s.snoozedUntil) } : {}),
      effortPending: s.effortPending,
      linkedPullRequests: s.linkedPullRequests.map((l) => ({ slug: l.slug, number: l.number, url: l.url, linkedAt: timestampFromDate(l.linkedAt) })),
      ...usageFields(s.usage),
      ...contextFields(s, this.cacheTTLSeconds()),
      ...agentCounts(this.logs.agentRunsOf(s.id)),
      // Shells die with the thread's process (mock/shells.ts).
      backgroundShellsRunning: s.state === ThreadState.CONNECTED ? this.logs.shellsOf(s.id) : 0,
      ...(s.retry ? { retry: { attempt: s.retry.attempt, maxRetries: s.retry.maxRetries, retryAt: timestampFromDate(s.retry.retryAt), errorStatus: s.retry.errorStatus, error: s.retry.error } } : {}),
    };
  }

  threadListSnapshot(): ThreadListEventInit {
    return { event: { case: "snapshot", value: { threads: [...this.threads.values()].map((s) => this.threadMsg(s)), retiredUsage: retiredUsage() } } };
  }

  thread(id: string): MockThread {
    const s = this.threads.get(id);
    if (!s) throw new CommandError("notfound", `thread ${id} not found`);
    return s;
  }

  private publishThread(s: MockThread): void {
    this.threadListEvents.publish({ event: { case: "updated", value: this.threadMsg(s) } });
  }

  /**
   * Thread → stopped (its claude process is gone: the idle stop, a crash). Like the daemon, the status it had
   * is kept, except busy, which becomes ERROR "interrupted".
   * `status`, when given, is the status it had at that moment (tests use it: s-1 flips
   * busy/idle on a timer).
   */
  stopThread(id: string, reason: string, code: number, status?: ThreadStatus): void {
    const s = this.thread(id);
    if (status !== undefined) this.setStatus(s, status);
    if (s.status === ThreadStatus.BUSY) this.setStatus(s, ThreadStatus.ERROR, "interrupted");
    s.state = ThreadState.DISCONNECTED;
    s.disconnectReason = reason;
    s.exitCode = code;
    s.settleIn = 0;
    // A stop while starting: the queued reply never comes (the daemon drops it with the process).
    s.onReady = [];
    s.lastActivityAt = new Date();
    this.publishThread(s);
  }

  /**
   * Claude linked a pull request to the thread (a pr-link transcript record): appended
   * unless its URL is already linked, like the daemon. agoMs backdates linkedAt (the
   * record's timestamp). Returns whether it was new.
   */
  linkPullRequest(id: string, slug: string, number: number, agoMs = 0): boolean {
    const s = this.thread(id);
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug) || !Number.isInteger(number) || number <= 0) throw new CommandError("invalid", "slug must be owner/name and number a positive integer");
    if (!Number.isFinite(agoMs) || agoMs < 0) throw new CommandError("invalid", "ago must be a non-negative number of milliseconds");
    const url = `https://github.com/${slug}/pull/${String(number)}`;
    if (s.linkedPullRequests.some((l) => l.url === url)) return false;
    s.linkedPullRequests = [...s.linkedPullRequests, { slug, number, url, linkedAt: new Date(Date.now() - agoMs) }];
    this.publishThread(s);
    return true;
  }

  /**
   * Claude made requests: adds counters to the thread's (model, day) bucket, or a new
   * bucket, and republishes the thread (the daemon's live fold, coarser).
   */
  addUsage(id: string, u: MockUsage): void {
    const s = this.thread(id);
    if (!u.model) throw new CommandError("invalid", "model is required");
    const counters = [u.requests, u.input, u.output, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h];
    if (counters.some((n) => !Number.isInteger(n) || n < 0)) throw new CommandError("invalid", "counters must be non-negative integers");
    const i = s.usage.findIndex((b) => b.model === u.model && b.day === u.day && (b.tier ?? "") === (u.tier ?? "") && (b.speed ?? "") === (u.speed ?? ""));
    const old = s.usage[i];
    const merged: MockUsage = old
      ? { ...old, requests: old.requests + u.requests, input: old.input + u.input, output: old.output + u.output, cacheRead: old.cacheRead + u.cacheRead, cacheWrite5m: old.cacheWrite5m + u.cacheWrite5m, cacheWrite1h: old.cacheWrite1h + u.cacheWrite1h }
      : u;
    s.usage = old ? s.usage.map((b, j) => (j === i ? merged : b)) : [...s.usage, merged];
    this.publishThread(s);
  }

  /** The detector's reading changed (reason defaults to a typical one for the status). */
  /** Test control: the clock stops (or, held false, resumes) changing this thread (MockThread.held); controls and input always do. */
  holdThread(id: string, held = true): void {
    this.thread(id).held = held;
  }

  setThreadStatus(id: string, status: ThreadStatus, reason?: string): void {
    const s = this.thread(id);
    if (s.state === ThreadState.DISCONNECTED) throw new CommandError("unavailable", "thread is disconnected");
    if (status === ThreadStatus.ERROR) throw new CommandError("invalid", "error is set only by a disconnect while busy");
    this.setStatus(s, status, reason);
    s.lastActivityAt = new Date();
    this.publishThread(s);
  }

  /** Sets status and reason, stamping statusChangedAt when either changes (Thread.setStatus). */
  private setStatus(s: MockThread, status: ThreadStatus, reason: string = defaultReason(status)): void {
    if (s.status === status && s.statusReason === reason) return;
    s.status = status;
    s.statusReason = reason;
    s.statusChangedAt = new Date();
  }

  /**
   * The sketch's scripted thread (mock/thread.ts) in a state: "Fix stale PR badge" in
   * code-foundry, connected, accept-edits. Replaces it when it exists.
   */
  addScriptedThread(state: ScriptedThreadState, id = "s-r1"): MockThread {
    if (this.threads.has(id)) {
      this.threads.delete(id);
      this.threadListEvents.publish({ event: { case: "removedId", value: id } });
    }
    const s = this.addThread({
      id,
      repoId: "repo-cf",
      worktreePath: CF,
      name: "Fix stale PR badge",
      model: "claude-opus-4-8[1m]",
      effort: "high",
      permissionMode: PermissionMode.ACCEPT_EDITS,
      createdAt: new Date(Date.now() - 10 * 60_000),
      // The earlier turn's result, two minutes ago: the cache is warm.
      contextTokens: 25_700,
      contextModel: "claude-opus-4-8",
      lastResultAt: new Date(Date.now() - 2 * 60_000),
      retry: null,
    });
    this.logs.load(id, state);
    // The agents panel sketch's thread (mock/agents.ts).
    if (state === "agents") s.name = "Agents panel";
    if (state === "stopped") {
      // Stopped at its prompt cache expiry: the last result is past the TTL, so the
      // composer's cold-cache note shows (the daemon's idle stop).
      s.lastResultAt = new Date(Date.now() - (this.cacheTTLSeconds() + 120) * 1000);
      this.stopThread(id, "idle", 0, ThreadStatus.IDLE);
    }
    if (state === "crashed") {
      // Before the handshake (the daemon's failStart): no turn ran; status error "did not start".
      s.lastError = `Claude did not start: exit code 1: ${CRASH_STDERR}`;
      s.contextTokens = 0;
      s.lastResultAt = null;
      this.stopThread(id, "spawn failed", 1, ThreadStatus.UNSPECIFIED);
      this.setStatus(s, ThreadStatus.ERROR, "did not start");
    }
    this.publishThread(s);
    return s;
  }

  /** threads.cache_ttl_seconds (the daemon's default when unset). */
  private cacheTTLSeconds(): number {
    return Number(this.settings.values()["threads.cache_ttl_seconds"] || 3600);
  }

  /** POST /__mock/thread/cache: the thread's last result `agoSeconds` ago (optionally with `tokens`, answered by `model`). */
  ageThreadCache(id: string, agoSeconds: number, tokens?: number, model?: string): void {
    const s = this.thread(id);
    s.lastResultAt = new Date(Date.now() - agoSeconds * 1000);
    if (tokens !== undefined) s.contextTokens = tokens;
    if (model !== undefined) s.contextModel = model;
    this.publishThread(s);
  }

  /**
   * POST /__mock/thread/retry: Claude retries a failed API request in `inSeconds`
   * (attempt/max, the HTTP status and Claude's error category), or with `clear` the
   * retry went through. The thread says busy meanwhile, as the daemon's would.
   */
  setThreadRetry(id: string, r: { inSeconds: number; attempt: number; maxRetries: number; errorStatus: number; error: string } | null): void {
    const s = this.thread(id);
    if (r) {
      s.retry = { attempt: r.attempt, maxRetries: r.maxRetries, retryAt: new Date(Date.now() + r.inSeconds * 1000), errorStatus: r.errorStatus, error: r.error };
      this.setStatus(s, ThreadStatus.BUSY);
    } else {
      s.retry = null;
    }
    this.publishThread(s);
  }

  /** Emits FocusThread for an existing thread. */
  focusThread(id: string): number {
    this.thread(id);
    return this.emit({ intent: { case: "focusThread", value: { threadId: id } } });
  }

  /** UiService.Emit: delivered to UiService watchers and EventService watchers with UI. */
  emit(intent: UiIntentInit): number {
    return this.intents.publish(intent) + this.uiEventWatchers;
  }

  /**
   * A new thread in STARTING. Unnamed for ~1s, then named `pendingName` (the daemon
   * names it in the background), connected after ~2s.
   */
  private createThread(repoId: string, path: string, model: string, effort: string, extra: Partial<MockThread> = {}): MockThread {
    const id = `s-new-${String(this.nextId++)}`;
    // With a first prompt the thread is on that turn already (the daemon says busy at spawn).
    const busy = extra.firstMessage ? { status: ThreadStatus.BUSY, statusReason: "working" } : {};
    const s = this.addThread({ id, repoId, worktreePath: path, name: "", model, effort, state: ThreadState.STARTING, settleIn: 2, nameIn: 1, pendingName: `thread-${id}`, createdAt: new Date(), ...busy, ...extra });
    this.publishThread(s);
    return s;
  }

  /**
   * thread.archive without its confirmation (POST /__mock/thread/archive does what the CLI
   * with --yes does). Archiving closes Claude (busy becomes ERROR "interrupted"), removes the
   * thread's shells, unpins it and stamps archivedAt (the first stamp is kept); unarchiving
   * only clears the stamp. Returns the command's message.
   */
  archiveThread(id: string, archived: boolean): string {
    const s = this.thread(id);
    const label = s.name ? `${s.name} (${s.id})` : s.id;
    if (!archived) {
      s.archivedAt = null;
      this.publishThread(s);
      return `unarchived thread ${label}`;
    }
    if (s.state !== ThreadState.DISCONNECTED) this.stopThread(s.id, "closed", 0);
    this.closeShells((l) => l[LABEL_THREAD] === s.id);
    s.pinned = false;
    s.archivedAt ??= new Date();
    s.snoozedUntil = null;
    this.publishThread(s);
    return `archived thread ${label}`;
  }

  /**
   * thread.snooze without its confirmation (POST /__mock/thread/snooze does what the CLI
   * with --yes does). Snoozing closes Claude like archiving (busy becomes ERROR
   * "interrupted"), removes the thread's shells, unpins and unarchives it and sets the wake
   * time (a re-snooze replaces it); null unsnoozes (no attention). Returns the message.
   */
  snoozeThread(id: string, until: Date | null): string {
    const s = this.thread(id);
    const label = s.name ? `${s.name} (${s.id})` : s.id;
    if (until === null) {
      s.snoozedUntil = null;
      this.publishThread(s);
      return `unsnoozed thread ${label}`;
    }
    if (s.state !== ThreadState.DISCONNECTED) this.stopThread(s.id, "closed", 0);
    this.closeShells((l) => l[LABEL_THREAD] === s.id);
    s.pinned = false;
    s.archivedAt = null;
    s.snoozedUntil = until;
    this.publishThread(s);
    return `snoozed thread ${label} until ${until.toISOString()}`;
  }

  /**
   * The daemon's wake (POST /__mock/thread/wake, or the tick once the time passed): the
   * snooze is cleared and a stopped thread needs attention, "snooze ended", stamped
   * now (re-stamped when it already read so).
   */
  wakeThread(id: string): void {
    const s = this.thread(id);
    s.snoozedUntil = null;
    if (s.state === ThreadState.DISCONNECTED) {
      s.status = ThreadStatus.NEEDS_ATTENTION;
      s.statusReason = "snooze ended";
      s.statusChangedAt = new Date();
    }
    this.publishThread(s);
  }

  /**
   * A message to a stopped thread (the daemon's startStopped): claude --resume in a new
   * process, STARTING until the handshake (~2 s), back in the thread list; the status it
   * persisted is replaced by busy "working" at once. `ready` runs once Claude is up; a
   * thread already starting (or stopping: the mock just starts it again) queues it.
   */
  startThread(id: string, ready: () => void): void {
    const s = this.thread(id);
    s.onReady.push(ready);
    if (s.state === ThreadState.STARTING) return;
    s.state = ThreadState.STARTING;
    s.archivedAt = null;
    s.snoozedUntil = null;
    // A message starts a turn: the saved status is replaced at once, like the daemon.
    this.setStatus(s, ThreadStatus.BUSY, "working");
    s.settleIn = 2;
    s.disconnectReason = "";
    s.exitCode = 0;
    s.lastError = "";
    s.lastActivityAt = new Date();
    this.publishThread(s);
  }

  /** archiveInterrupts over the thread's own background agents and shells. */
  private interrupts(s: MockThread): { why: string; ends: string } {
    const { backgroundAgentsRunning } = agentCounts(this.logs.agentRunsOf(s.id));
    return archiveInterrupts(s, backgroundAgentsRunning, this.logs.shellsOf(s.id));
  }

  private tickThreads(): void {
    for (const s of this.threads.values()) {
      if (s.held) continue;
      if (s.snoozedUntil !== null && s.snoozedUntil.getTime() <= Date.now()) this.wakeThread(s.id);
      // A queued run-in: the daemon sends set_cwd once the thread is idle.
      if (s.pendingWorktreePath && s.status !== ThreadStatus.BUSY && --s.moveIn <= 0) this.applyMove(s);
      if (s.nameIn > 0 && --s.nameIn === 0 && !s.name) {
        s.name = s.pendingName;
        this.publishThread(s);
      }
      if (s.settleIn > 0 && --s.settleIn === 0) {
        if (s.state === ThreadState.STARTING) {
          s.state = ThreadState.CONNECTED;
          // A message waiting for the handshake keeps it busy (the reply follows below).
          if (s.onReady.length === 0 && !s.firstMessage) this.setStatus(s, ThreadStatus.IDLE);
          this.publishThread(s);
          // A new thread: its first message goes out once Claude answered the handshake.
          const first = s.firstMessage;
          s.firstMessage = null;
          if (first) this.logs.send(s.id, first.text, first.attachments, first.composerText);
          // A stopped thread started by a message: the reply follows now.
          const ready = s.onReady;
          s.onReady = [];
          for (const f of ready) f();
        } else if (s.state === ThreadState.CLOSING) {
          this.stopThread(s.id, "closed", 0);
        }
        continue;
      }
      // s-1 alternates busy/idle every 4s; attention sticks until input arrives.
      if (s.id === "s-1" && s.state === ThreadState.CONNECTED && s.status !== ThreadStatus.NEEDS_ATTENTION && this.seconds % 4 === 0) {
        this.setStatus(s, s.status === ThreadStatus.BUSY ? ThreadStatus.IDLE : ThreadStatus.BUSY);
        s.lastActivityAt = new Date();
        this.publishThread(s);
      }
    }
  }

  private addTerm(o: { id: string; argv: string[]; cwd: string; title: string; kind: Kind; labels: Record<string, string>; startedAt?: Date }): MockTerm {
    const t: MockTerm = {
      id: o.id,
      argv: o.argv,
      cwd: o.cwd,
      cols: 120,
      rows: 36,
      title: o.title,
      state: TerminalState.RUNNING,
      exitCode: 0,
      startedAt: o.startedAt ?? new Date(),
      exitedAt: null,
      altScreen: false,
      labels: o.labels,
      kind: o.kind,
      history: "",
      line: "",
      tick: 0,
      attach: new Hub<AttachItem>(),
    };
    switch (o.kind) {
      case "top":
        t.history = `${prompt(o.cwd)}top\r\n`;
        t.altScreen = true;
        break;
      case "shell":
        t.history = `${RESET}Last login: Thu Oct  8 09:12:44 on ttys004\r\n${prompt(o.cwd)}`;
        break;
      case "action":
        // `$SHELL -lc <command>` prints only the command's output (the GUI draws the command).
        break;
    }
    this.terms.set(t.id, t);
    return t;
  }

  start(): void {
    this.timer ??= setInterval(() => {
      this.tick();
    }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.seconds++;
    this.tickThreads();
    for (const t of this.terms.values()) {
      if (t.state !== TerminalState.RUNNING) continue;
      t.tick++;
      if (t.kind === "top" && t.altScreen) {
        this.output(t, topFrame(t.tick, t.cols, t.rows));
      }
    }
    if (this.seconds % 8 === 0) {
      const repo = this.repos.get("repo-cf");
      const w = repo?.worktrees.find((x) => x.branch === "feat/sidebar");
      if (repo && w) {
        w.status.modified = w.status.modified === 3 ? 4 : 3;
        this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
      }
    }
  }

  private output(t: MockTerm, s: string): void {
    if (!t.altScreen) {
      t.history += s;
      if (t.history.length > HISTORY_CAP) {
        const cut = t.history.indexOf("\n", t.history.length - HISTORY_CAP);
        t.history = t.history.slice(cut + 1);
      }
    }
    t.attach.publish({ event: { case: "output", value: { data: enc.encode(s) } } });
  }

  private publishTerm(t: MockTerm): void {
    this.termEvents.publish({ event: { case: "updated", value: this.terminalMsg(t) } });
  }

  // ---- Terminal API -------------------------------------------------------------

  terminalMsg(t: MockTerm): TerminalInit {
    return {
      id: t.id,
      argv: t.argv,
      cwd: t.cwd,
      cols: t.cols,
      rows: t.rows,
      title: t.title,
      state: t.state,
      exitCode: t.exitCode,
      startedAt: timestampFromDate(t.startedAt),
      exitedAt: t.exitedAt ? timestampFromDate(t.exitedAt) : undefined,
      altScreen: t.altScreen,
      labels: t.labels,
    };
  }

  term(id: string): MockTerm {
    const t = this.terms.get(id);
    if (!t) throw new CommandError("notfound", `terminal ${id} not found`);
    return t;
  }

  snapshot(t: MockTerm): AttachEventInit {
    let data = `\x1b[0m${t.history}`;
    if (t.altScreen) data += ENTER_ALT + topFrame(t.tick, t.cols, t.rows);
    return { event: { case: "snapshot", value: { data: enc.encode(data), cols: t.cols, rows: t.rows, altScreen: t.altScreen } } };
  }

  create(argv: string[], cwd: string, labels: Record<string, string>, kind: Kind): MockTerm {
    const id = `t-new-${String(this.nextId++)}`;
    const t = this.addTerm({ id, argv, cwd, title: "", kind, labels });
    this.publishTerm(t);
    return t;
  }

  write(id: string, data: Uint8Array): void {
    const t = this.term(id);
    const text = new TextDecoder().decode(data);
    this.writes.push({ id, data: text });
    if (t.state !== TerminalState.RUNNING) return;
    if (t.kind === "action") {
      // No shell reads the keys; ^C interrupts the command (SIGINT: 130).
      if (text.includes("\x03")) this.kill(id, 130);
      return;
    }
    if (t.kind === "top") {
      if (text.includes("q")) {
        t.altScreen = false;
        t.kind = "shell";
        t.attach.publish({ event: { case: "output", value: { data: enc.encode("\x1b[?1049l\x1b[?25h") } } });
        this.output(t, prompt(t.cwd));
        this.publishTerm(t);
      }
      return;
    }
    // Shell-ish line discipline: echo, backspace, enter, ^C. Escape sequences ignored.
    // eslint-disable-next-line no-control-regex
    const plain = text.replace(/\x1b\[20[01]~/g, "").replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/g, "");
    let out = "";
    for (const ch of plain) {
      if (ch === "\r") {
        const cmd = t.line.trim();
        t.line = "";
        out += "\r\n";
        out += cmd ? `zsh: command not found: ${cmd.split(" ")[0] ?? ""}\r\n${prompt(t.cwd)}` : prompt(t.cwd);
      } else if (ch === "\x7f") {
        if (t.line.length > 0) {
          t.line = t.line.slice(0, -1);
          out += "\b \b";
        }
      } else if (ch === "\x03") {
        t.line = "";
        out += `^C\r\n${prompt(t.cwd)}`;
      } else if (ch >= " ") {
        t.line += ch;
        out += ch;
      }
    }
    if (out) this.output(t, out);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.term(id);
    if (cols < 1 || rows < 1) throw new CommandError("invalid", "cols and rows must be positive");
    this.resizes.push({ id, cols, rows });
    if (t.cols === cols && t.rows === rows) return;
    t.cols = cols;
    t.rows = rows;
    t.attach.publish({ event: { case: "resized", value: { cols, rows } } });
    if (t.altScreen && t.state === TerminalState.RUNNING) this.output(t, "\x1b[2J" + topFrame(t.tick, cols, rows));
    this.publishTerm(t);
  }

  /**
   * Ends a terminal. `keep` leaves an exited shell in place (the reaper has not got to it
   * yet; tests use it to see the exit overlay).
   */
  kill(id: string, code = 129, keep = false): void {
    const t = this.term(id);
    if (t.state !== TerminalState.RUNNING) return;
    if (t.altScreen) {
      t.altScreen = false;
      t.attach.publish({ event: { case: "output", value: { data: enc.encode("\x1b[?1049l\x1b[?25h") } } });
    }
    t.state = TerminalState.EXITED;
    t.exitCode = code;
    t.exitedAt = new Date();
    t.attach.publish({ event: { case: "exited", value: { exitCode: code } } });
    t.attach.publish("end");
    this.publishTerm(t);
    // An action run's terminal: its run finishes with this code (the terminal stays, EXITED).
    this.actions.terminalExited(id, code);
    // Like the daemon's shell reaper: a shell terminal.new started is removed once it exits.
    if (t.labels[LABEL_KIND] === KIND_SHELL && !keep) this.remove(id);
  }

  /** terminal.close / TerminalService.Close: kill, then remove once exited. Only shells and action runs, like the daemon. */
  close(id: string): void {
    const t = this.term(id);
    if (!isPanel(t.labels)) throw new CommandError("unavailable", `terminal ${id} is not a shell`);
    this.kill(id);
    if (this.terms.get(id)?.state === TerminalState.EXITED) this.remove(id);
  }

  /** Closes every running or exited shell or action terminal whose labels match (thread or worktree removal). */
  private closeShells(match: (labels: Record<string, string>) => boolean): void {
    for (const t of [...this.terms.values()]) {
      if (isPanel(t.labels) && match(t.labels) && this.terms.has(t.id)) this.close(t.id);
    }
  }

  /**
   * Who owns a shell terminal.new starts, like the daemon (internal/command/commands_terminal.go):
   * the active thread, else the active registered worktree, else the deepest registered worktree
   * containing cwd. Refuses a cwd outside every project.
   */
  private shellOwner(ctx: UiContext | undefined, cwd: string): { labels: Record<string, string>; cwd: string } {
    const s = ctx?.activeThreadId ? this.threads.get(ctx.activeThreadId) : undefined;
    if (ctx?.activeThreadId) {
      if (!s) throw new CommandError("notfound", `thread ${ctx.activeThreadId} not found`);
      return { labels: shellLabels(s.id, s.repoId, s.worktreePath), cwd: cwd || s.worktreePath };
    }
    const exact = ctx?.activeRepoId ? this.repos.get(ctx.activeRepoId)?.worktrees.find((w) => w.path === ctx.activeWorktreePath) : undefined;
    if (exact && ctx) return { labels: shellLabels("", ctx.activeRepoId, exact.path), cwd: cwd || exact.path };
    const path = cwd || ctx?.activeWorktreePath || "";
    let best: { repoId: string; path: string } | null = null;
    for (const repo of this.repos.values()) {
      for (const w of repo.worktrees) {
        if ((path === w.path || path.startsWith(`${w.path}/`)) && w.path.length > (best?.path.length ?? 0)) best = { repoId: repo.id, path: w.path };
      }
    }
    if (!best) throw new CommandError("invalid", `${path} is not inside a registered project`);
    return { labels: shellLabels("", best.repoId, best.path), cwd: cwd || best.path };
  }

  /**
   * A daemon restart as the GUI sees it: every shell is gone (the daemon prunes them) with
   * no `removed` events, and the event streams end, so the GUI reconnects and learns it
   * from TerminalService.List. Threads and other terminals stay.
   */
  restartDaemon(): void {
    for (const t of [...this.terms.values()]) {
      if (!isPanel(t.labels)) continue;
      this.terms.delete(t.id);
      t.attach.publish("end");
    }
    this.actions.restart();
    this.events.endAll();
    this.termEvents.endAll();
  }

  remove(id: string): void {
    const t = this.term(id);
    if (t.state === TerminalState.RUNNING) throw new CommandError("unavailable", "terminal is still running");
    this.terms.delete(id);
    t.attach.publish("end");
    this.termEvents.publish({ event: { case: "removedId", value: id } });
    this.actions.terminalRemoved(id);
  }

  /**
   * thread.new like the daemon: an explicit worktree, or (new-worktree) a cf/<slug>
   * worktree made from `base` first, which takes a moment. A prompt containing FAIL
   * fails the way a git error would, before any thread exists.
   */
  private async newThread(ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> {
    if (args["no-project"] === "true") return this.newHomeThread(ctx, args);
    if (args.workspace || args.repos) return this.newWorkspaceThread(args);
    const repo = this.repos.get(args.repo || ctx?.activeRepoId || "") ?? this.worktreeOf(ctx)?.repo;
    if (!repo) throw new CommandError("invalid", "a worktree or repository is required");
    const first = firstMessageOf(args);
    const prompt = args.prompt ?? "";
    const permission = args.permission ?? "";
    if (permission && !(permission in permissionModes)) throw new CommandError("invalid", `permission must be supervised, accept-edits or auto`);
    for (const p of (args.attachments ?? "").split(",").filter(Boolean)) {
      if (!this.attachments.has(p)) throw new CommandError("invalid", `attachment ${p} was not staged`);
    }
    const slug = promptSlug(prompt);
    const gen = this.generation;
    const settle = async (ms: number) => {
      await sleep(ms);
      if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while thread.new ran");
    };
    let path = args.worktree ?? "";
    let baseRef = "";
    const created = args["new-worktree"] === "true";
    if (created) requireGit(repo, "a new worktree");
    if (created) {
      baseRef = args.base || (repo.remotes.length > 0 ? `origin/${repo.defaultBranch}` : repo.defaultBranch);
      await settle(this.worktreeDelayMs);
      if (prompt.includes("FAIL")) {
        throw new CommandError("unavailable", repo.remotes.length > 0 ? `create worktree: git fetch origin ${baseRef.replace(/^origin\//, "")}: exit status 128` : `create worktree: git worktree add: invalid reference: ${baseRef}`);
      }
      const branch = `cf/${slug || `s-new-${String(this.nextId)}`}`;
      path = this.addWorktree(repo, branch, baseRef).path;
    } else {
      path ||= repo.worktrees.find((w) => w.isMain)?.path ?? repo.path;
      if (!repo.worktrees.some((w) => w.path === path)) throw new CommandError("invalid", `worktree ${path} is not in ${repo.name}`);
      await settle(150);
      if (prompt.includes("FAIL")) throw new CommandError("unavailable", "start claude: exec: \"claude\": executable file not found in $PATH");
    }
    const model = args.model || "claude-opus-4-8[1m]";
    const s = this.createThread(repo.id, path, model, args.effort ?? "", {
      name: args.name ?? "",
      autoNamed: !args.name,
      // Named in the background a moment after it starts (1–2 ticks), like the daemon.
      nameIn: args.name ? 0 : 2,
      pendingName: promptTitle(prompt) || `thread-${String(this.nextId)}`,
      permissionMode: permissionModes[permission] ?? PermissionMode.UNSPECIFIED,
      baseRef,
      createdWorktree: created,
      firstMessage: first,
    });
    // Like the daemon's WorktreeCreated: the project's on-worktree-create actions, in the background.
    if (created) this.actions.worktreeCreated(s.id, repo.id, path);
    this.focusThread(s.id);
    return { message: `created thread ${s.id} in ${path}`, resultJson: JSON.stringify({ id: s.id, worktreePath: path }) };
  }

  /**
   * thread.new --no-project like the daemon: a thread with no repo or workspace in the
   * home directory. Refuses any arg that places it, a repo or worktree from the caller's
   * context included.
   */
  private async newHomeThread(ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> {
    for (const name of ["repo", "worktree", "workspace", "repos", "new-worktree", "base"]) {
      if (args[name]) throw new CommandError("invalid", `no-project starts a thread without a project; it does not take ${name}`);
    }
    if (ctx?.activeRepoId) throw new CommandError("invalid", "no-project starts a thread without a project; it does not take repo");
    if (ctx?.activeWorktreePath) throw new CommandError("invalid", "no-project starts a thread without a project; it does not take worktree");
    const prompt = args.prompt ?? "";
    const permission = args.permission ?? "";
    const gen = this.generation;
    await sleep(150);
    if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while thread.new ran");
    const s = this.createThread("", HOME, args.model || "opus", args.effort ?? "", {
      name: args.name ?? "",
      autoNamed: !args.name,
      nameIn: args.name ? 0 : 2,
      pendingName: promptTitle(prompt) || `thread-${String(this.nextId)}`,
      permissionMode: permissionModes[permission] ?? PermissionMode.UNSPECIFIED,
      firstMessage: firstMessageOf(args),
    });
    this.focusThread(s.id);
    return { message: `created thread ${s.id} in ${HOME} (no project)`, resultJson: JSON.stringify({ id: s.id, worktreePath: HOME }) };
  }

  /**
   * thread.new with `workspace` (a thread owned by it, in the member `worktree` or
   * `repo` names, else the first) or `repos` with new-worktree (a new workspace named
   * from the prompt with cf/<slug> in every repo, the thread in `repo`'s member).
   */
  private async newWorkspaceThread(args: Record<string, string>): Promise<InvokeOut> {
    const created = args["new-worktree"] === "true";
    const prompt = args.prompt ?? "";
    const permission = args.permission ?? "";
    if (args.workspace && created) throw new CommandError("invalid", "a workspace thread runs in an existing member; for a new workspace use new-worktree with repos");
    if (args.repos && !created) throw new CommandError("invalid", "repos only applies with new-worktree");
    const first = firstMessageOf(args);
    for (const p of (args.attachments ?? "").split(",").filter(Boolean)) {
      if (!this.attachments.has(p)) throw new CommandError("invalid", `attachment ${p} was not staged`);
    }
    const gen = this.generation;
    const settle = async (ms: number) => {
      await sleep(ms);
      if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while thread.new ran");
    };
    const slug = promptSlug(prompt);
    let ws: MockWorkspace;
    let baseRef = "";
    if (args.workspace) {
      ws = this.workspaceRef(args.workspace);
      await settle(150);
      if (prompt.includes("FAIL")) throw new CommandError("unavailable", "start claude: exec: \"claude\": executable file not found in $PATH");
    } else {
      const refs = (args.repos ?? "").split(",").map((r) => r.trim()).filter(Boolean);
      for (const ref of refs) this.memberRepoRef(ref.split(":")[0] ?? "");
      await settle(this.worktreeDelayMs);
      if (prompt.includes("FAIL")) throw new CommandError("unavailable", "create workspace: git worktree add: invalid reference: origin/nope");
      let name = slug || `s-new-${String(this.nextId)}`;
      for (let i = 2; [...this.workspaces.values()].some((w) => w.name === name); i++) name = `${slug}-${String(i)}`;
      ws = this.addWorkspace(name, refs);
      const own = refs.find((r) => this.repoRef(r.split(":")[0] ?? "").id === (args.repo ? this.repoRef(args.repo).id : ws.members[0]?.repoId));
      baseRef = own?.split(":")[1] ?? "";
    }
    const byPath = args.worktree ? ws.members.find((m) => m.worktreePath === args.worktree) : undefined;
    if (args.worktree && !byPath) throw new CommandError("unavailable", `${args.worktree} is not a member worktree of workspace ${ws.name}`);
    const repoId = args.repo ? this.repoRef(args.repo).id : "";
    if (byPath && repoId && byPath.repoId !== repoId) throw new CommandError("invalid", `worktree ${byPath.worktreePath} belongs to repo ${byPath.repoId}, not ${repoId}`);
    const member = byPath ?? (repoId ? ws.members.find((m) => m.repoId === repoId) : ws.members[0]);
    if (!member) throw new CommandError("unavailable", `repo ${repoId} is not a member of workspace ${ws.name}`);
    const repo = this.repoRef(member.repoId);
    if (created && !baseRef) baseRef = repo.remotes.length > 0 ? `origin/${repo.defaultBranch}` : repo.defaultBranch;
    const s = this.createThread(member.repoId, member.worktreePath, args.model || "claude-opus-4-8[1m]", args.effort ?? "", {
      name: args.name ?? "",
      autoNamed: !args.name,
      nameIn: args.name ? 0 : 2,
      pendingName: promptTitle(prompt) || `thread-${String(this.nextId)}`,
      permissionMode: permissionModes[permission] ?? PermissionMode.UNSPECIFIED,
      baseRef,
      createdWorktree: created,
      workspaceId: ws.id,
      firstMessage: first,
    });
    this.focusThread(s.id);
    return { message: `created thread ${s.id} in ${member.worktreePath} (workspace ${ws.id})`, resultJson: JSON.stringify({ id: s.id, worktreePath: member.worktreePath, workspaceId: ws.id }) };
  }

  /**
   * ThreadService.StageAttachment: keeps the bytes' size and the page hint, returns a fake
   * path; a PDF's carries the count like the daemon's (the hint, else "~1").
   */
  stageAttachment(name: string, mimeType: string, size: number, pages = 0): string {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(mimeType)) throw new CommandError("invalid", `unsupported attachment type ${mimeType}`);
    const max = mimeType === "application/pdf" ? 20 : 10;
    if (size > max * 1024 * 1024) throw new CommandError("invalid", `attachment larger than ${String(max)} MiB`);
    const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? "").toLowerCase();
    const count = mimeType === "application/pdf" ? `-${pages > 0 ? String(pages) : "~1"}p` : "";
    const path = `${HOME}/.code-foundry/attachments/att-${String(this.attachments.size + 1)}${count}${ext}`;
    this.attachments.set(path, { name, mimeType, size, pages });
    return path;
  }

  /** RepoService.ListRefs: local branches, then remote-tracking refs, and the default base. */
  listRefs(repoId: string): { refs: string[]; defaultRef: string } {
    const repo = this.repos.get(repoId);
    if (!repo) throw new CommandError("notfound", `repo ${repoId} not found`);
    requireGit(repo, "listing refs");
    const local = [...new Set([...repo.worktrees.map((w) => w.branch), ...(repo.branches ?? [])].filter(Boolean))].sort();
    const remote = !repo.remotes.includes("origin") ? [] : repo.githubSlug ? ["origin/main", "origin/release/v0.3", "origin/feat/sidebar"].sort() : [`origin/${repo.defaultBranch}`];
    return { refs: [...local, ...remote], defaultRef: remote.length > 0 ? `origin/${repo.defaultBranch}` : repo.defaultBranch };
  }

  /** Test control: the worktree at `path` checks out `branch` ("" detaches HEAD). False when there is no such worktree. */
  checkout(path: string, branch: string): boolean {
    for (const repo of this.repos.values()) {
      const w = repo.worktrees.find((x) => x.path === path);
      if (!w) continue;
      w.branch = branch;
      w.detached = branch === "";
      this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
      return true;
    }
    return false;
  }

  /**
   * A git operation stops in the worktree at `path` (POST /__mock/worktree/operation): the
   * status carries it and `conflicted` unmerged entries, which lead the worktree detail as
   * U files (`files`, else conflict_1.go, ...). An empty `op` ends it: the status clears
   * and the U files go.
   */
  setOperation(path: string, op: string, step: number, total: number, conflicted: number, files: string[]): boolean {
    for (const repo of this.repos.values()) {
      const w = repo.worktrees.find((x) => x.path === path);
      if (!w) continue;
      w.status = op
        ? { ...w.status, operation: op, operationStep: step, operationTotal: total, conflicted, dirty: w.status.dirty || conflicted > 0 }
        : { ...w.status, operation: "", operationStep: 0, operationTotal: 0, conflicted: 0 };
      const names = op ? Array.from({ length: conflicted }, (_, i) => files[i] ?? `conflict_${String(i + 1)}.go`) : [];
      this.gh.setConflicts(path, names);
      this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
      return true;
    }
    return false;
  }

  // ---- Repo API -----------------------------------------------------------------

  worktreeMsg(repoId: string, w: MockWorktree): WorktreeInit {
    return { repoId, path: w.path, branch: w.branch, head: w.head, detached: w.detached ?? false, isMain: w.isMain, mergedClean: mergedClean(w), status: { ...w.status, refreshedAt: timestampFromDate(new Date()) } };
  }

  repoMsg(r: MockRepo): RepoInit {
    return { id: r.id, path: r.path, name: r.name, defaultBranch: r.defaultBranch, githubSlug: r.githubSlug, remotes: r.remotes, git: r.git !== false, worktrees: r.worktrees.map((w) => this.worktreeMsg(r.id, w)) };
  }

  /**
   * RepoService.Register (the Add Project dialog's Local folder tab and an existing clone
   * destination), with the daemon's rules: "~" expands, the path must be absolute and
   * under home, a folder inside a git repository adds that repository, any other folder
   * a project without git, and an already registered project is returned unchanged.
   */
  registerFolder(raw: string): MockRepo {
    if (raw === "") throw new CommandError("invalid", "invalid argument: path is required");
    if (raw.startsWith("~") && raw !== "~" && !raw.startsWith("~/")) throw new CommandError("invalid", `~user paths are not supported: "${raw}"`);
    const expanded = raw.replace(/^~(?=\/|$)/, HOME);
    if (!expanded.startsWith("/")) throw new CommandError("invalid", `want an absolute path, got "${raw}"`);
    const segs: string[] = [];
    for (const seg of expanded.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") segs.pop();
      else segs.push(seg);
    }
    const path = `/${segs.join("/")}`;
    if (path !== HOME && !path.startsWith(`${HOME}/`)) throw new CommandError("invalid", `invalid argument: ${path} is outside your home directory`);
    const registered = (p: string) =>
      [...this.repos.values()].find((r) => r.path === p || p.startsWith(`${r.path}/`) || r.worktrees.some((w) => w.path === p || p.startsWith(`${w.path}/`)));
    const known = registered(path);
    if (known) return known;
    const folder = projectFolder(path) ?? (cloneExists(path) ? { path, git: true } : undefined);
    if (!folder) throw new CommandError("invalid", `invalid argument: ${path}: no such file or directory`);
    const again = registered(folder.path);
    if (again) return again;
    const name = folder.path.split("/").pop() || folder.path;
    let id = `repo-${name.toLowerCase()}`;
    for (let n = 2; this.repos.has(id); n++) id = `repo-${name.toLowerCase()}-${String(n)}`;
    const repo: MockRepo = folder.git
      ? { id, path: folder.path, name, defaultBranch: "main", githubSlug: "", remotes: [], worktrees: [{ path: folder.path, branch: "main", head: "deadbeef", isMain: true, status: clean() }] }
      : {
          id,
          path: folder.path,
          name,
          defaultBranch: "",
          githubSlug: "",
          remotes: [],
          git: false,
          worktrees: [{ path: folder.path, branch: "", head: "", isMain: true, status: clean() }],
        };
    this.repos.set(id, repo);
    this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
    return repo;
  }

  /** RepoService.Clone's last step: a cloned GitHub repository registered at path. */
  addClone(owner: string, name: string, path: string): MockRepo {
    let id = `repo-${name.toLowerCase()}`;
    for (let n = 2; this.repos.has(id); n++) id = `repo-${name.toLowerCase()}-${String(n)}`;
    const repo: MockRepo = {
      id,
      path,
      name,
      defaultBranch: "main",
      githubSlug: `${owner}/${name}`,
      remotes: ["origin"],
      worktrees: [{ path, branch: "main", head: "c1013ed0", isMain: true, status: clean() }],
    };
    this.repos.set(id, repo);
    this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
    return repo;
  }

  /**
   * RepoService.InitGit and repo.git.init: a project without git becomes a git repository
   * on main (the empty "Initial commit"), its folder the main worktree on that branch.
   */
  initGit(id: string): MockRepo {
    const repo = this.repos.get(id);
    if (!repo) throw new CommandError("notfound", `repo ${id} not found`);
    if (repo.git !== false) throw new CommandError("unavailable", `${repo.name} is already a git repository`);
    repo.git = true;
    repo.defaultBranch = "main";
    repo.worktrees = repo.worktrees.map((w) => (w.isMain ? { ...w, branch: "main", head: "1a1t1a10", status: clean({ upstream: "", baseRef: "", untracked: 3, dirty: true }) } : w));
    this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
    return repo;
  }

  // ---- New projects and publishing (mock/create.ts) --------------------------------

  /** Every project's folder (repo.create refuses a taken one). */
  projectPaths(): string[] {
    return [...this.repos.values()].map((r) => r.path);
  }

  repoInfo(id: string): { name: string; path: string; git: boolean; remotes: string[] } | undefined {
    const r = this.repos.get(id);
    return r && { name: r.name, path: r.path, git: r.git !== false, remotes: r.remotes };
  }

  /** RepoService.Delete (and repo.unregister): the project is gone. */
  removeRepo(id: string): void {
    this.actions.removeRepo(id);
    this.repos.delete(id);
    this.repoEvents.publish({ event: { case: "repoRemovedId", value: id } });
  }

  /** RepoService.Create: a git project on main with its empty first commit, no remote. */
  addCreated(name: string, path: string): { id: string; name: string; path: string } {
    let id = `repo-${name.toLowerCase()}`;
    for (let n = 2; this.repos.has(id); n++) id = `repo-${name.toLowerCase()}-${String(n)}`;
    const repo: MockRepo = {
      id,
      path,
      name,
      defaultBranch: "main",
      githubSlug: "",
      remotes: [],
      worktrees: [{ path, branch: "main", head: "1n1t1a10", isMain: true, status: clean({ upstream: "", baseRef: "" }) }],
    };
    this.repos.set(id, repo);
    this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
    return { id, name, path };
  }

  /** RepoService.Publish succeeded: origin on GitHub, main tracking origin/main. */
  setOrigin(id: string, slug: string): void {
    const repo = this.repos.get(id);
    if (!repo) return;
    repo.remotes = ["origin"];
    repo.githubSlug = slug;
    repo.worktrees = repo.worktrees.map((w) => (w.isMain ? { ...w, status: { ...w.status, upstream: "origin/main", baseRef: "origin/main" } } : w));
    this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
  }

  // ---- Commands -----------------------------------------------------------------

  private worktreeOf(ctx: UiContext | undefined): { repo: MockRepo; wt: MockWorktree } | null {
    if (!ctx?.activeWorktreePath) return null;
    for (const repo of this.repos.values()) {
      const wt = repo.worktrees.find((w) => w.path === ctx.activeWorktreePath);
      if (wt) return { repo, wt };
    }
    return null;
  }

  /**
   * pr.ask, pr.explain and pr.fix.findings (internal/command/commands_prthread.go): start a
   * thread about a pull request and focus it. The worktree rules follow the daemon's
   * pickPRWorktree; the prompt is not built here (the mock's threads never read it).
   */
  private prThreadCommands(): ReturnType<World["registry"]> {
    const slugArg = { name: "repo-slug", type: ArgType.STRING, required: true, description: 'GitHub repository, "owner/name"' };
    const numberArg = { name: "number", type: ArgType.INT, required: true, description: "Pull request number" };
    const worktreeArg = { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree to start the thread in (default: picked from the registered clones of repo-slug and the pull request's branch)" };
    const modelArg = { name: "model", type: ArgType.ENUM, required: false, description: "Model (default: settings threads.default_model, else Claude's default)", enumValues: MODEL_VALUES };
    const effortArg = { name: "effort", type: ArgType.ENUM, required: false, description: "Effort level (default: settings threads.default_effort, else Claude's default)", enumValues: ["low", "medium", "high", "xhigh", "max"] };
    const start =
      (fix: boolean) =>
      async (ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> => {
        // POST /__mock/gh/pr-delay?ms=800: these commands take that long (fetch, worktree, start).
        if (this.gh.prDetails.threadDelayMs > 0) await new Promise((r) => setTimeout(r, this.gh.prDetails.threadDelayMs));
        const slug = args["repo-slug"] ?? "";
        const n = Number(args.number);
        if (!slug.trim()) throw new CommandError("invalid", "repo-slug is required");
        if (!Number.isInteger(n) || n <= 0) throw new CommandError("invalid", "number must be a positive pull request number");
        // POST /__mock/gh/pr-fail?command=pr.fix.findings (or pr.ask, pr.explain): the next run fails.
        // Codes as the daemon's (internal/command/commands_prthread.go): the fork is a
        // FailedPrecondition, a GitHub 502 while reading the pull request is Unavailable.
        if (this.gh.prDetails.failNext.delete(fix ? "pr.fix.findings" : (args.question ?? "") !== "" ? "pr.ask" : "pr.explain")) {
          throw fix
            ? new ConnectError(
                `#${String(n)} comes from a fork and no worktree of ${slug} has its head checked out: check it out (for example \`gh pr checkout ${String(n)}\` in a worktree) and pass --worktree`,
                Code.FailedPrecondition,
              )
            : new ConnectError(`read #${String(n)}: github graphql: 502 Bad Gateway`, Code.Unavailable);
        }
        const pr = prDetailCall(() => this.gh.prDetails.get(slug, n, fix)).pullRequest;
        const head = pr?.headRef ?? "";
        const headSha = pr?.headSha ?? "";
        const cross = pr?.isCrossRepository ?? false;
        // checkedOutIn: a same-repository head by branch name; a fork's head by commit, or
        // by an upstream <remote>/<head> on a remote other than origin.
        const onHead = (w: MockWorktree): boolean => {
          if (!cross) return head !== "" && w.branch === head;
          if (headSha && w.head.toLowerCase() === headSha.toLowerCase()) return true;
          if (!head || !w.status.upstream.endsWith(`/${head}`)) return false;
          const remote = w.status.upstream.slice(0, -head.length - 1);
          return remote !== "" && remote !== "origin";
        };
        const clones = [...this.repos.values()].filter((r) => r.githubSlug !== "" && r.githubSlug.toLowerCase() === slug.toLowerCase());
        const find = (pred: (w: MockWorktree) => boolean): { repoId: string; path: string } | null => {
          for (const r of clones) {
            const w = r.worktrees.find(pred);
            if (w) return { repoId: r.id, path: w.path };
          }
          return null;
        };
        let target: { repoId: string; path: string } | null = null;
        if (args.worktree) {
          const owner = [...this.repos.values()].find((r) => r.worktrees.some((w) => w.path === args.worktree));
          target = { repoId: owner?.id ?? "", path: args.worktree };
        } else {
          const first = clones[0];
          if (!first) throw new CommandError("unavailable", `no registered repository is a clone of ${slug}: add one with \`code-foundry repo add <folder>\`, or pass --worktree`);
          const active = ctx?.activeWorktreePath;
          if (!fix && active) target = find((w) => w.path === active);
          if (!target) target = find(onHead);
          if (!target && !fix) target = { repoId: first.id, path: first.worktrees.find((w) => w.isMain)?.path ?? first.path };
          if (!target) {
            if (!head) throw new CommandError("unavailable", `#${String(n)} has no head branch to check out: pass --worktree`);
            if (cross) throw new CommandError("unavailable", `#${String(n)} comes from a fork and no worktree of ${slug} has its head checked out: check it out (for example \`gh pr checkout ${String(n)}\` in a worktree) and pass --worktree`);
            // The daemon fetches origin/<head> and creates the branch tracking it.
            const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${first.githubSlug}/${head.replace(/\//g, "-")}`, branch: head, head: pr?.headSha ?? "c0ffee00", isMain: false, status: clean({ upstream: `origin/${head}`, baseRef: "" }) };
            first.worktrees.push(w);
            this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(first.id, w) } });
            target = { repoId: first.id, path: w.path };
          }
        }
        const defaults = this.threadDefaults();
        const s = this.createThread(target.repoId, target.path, args.model ?? defaults.model, args.effort ?? defaults.effort);
        this.focusThread(s.id);
        // Like the daemon: the result JSON is the created Thread (protojson).
        return {
          message: `Started thread ${s.id} for PR #${String(n)}`,
          resultJson: JSON.stringify({ id: s.id, repoId: s.repoId, worktreePath: s.worktreePath, model: s.model, effort: s.effort }),
        };
      };
    const always = () => true;
    return [
      {
        cmd: {
          name: "pr.ask",
          title: "Ask About Pull Request",
          category: "Pull Request",
          description: "Start a thread that answers a question about a pull request without changing code.",
          keybindings: [],
          args: [slugArg, numberArg, { name: "question", type: ArgType.STRING, required: true, description: "What to ask" }, worktreeArg, modelArg, effortArg],
        },
        when: always,
        run: (ctx, args) => {
          if (!(args.question ?? "").trim()) throw new CommandError("invalid", "question is required");
          return start(false)(ctx, args);
        },
      },
      {
        cmd: {
          name: "pr.explain",
          title: "Explain Pull Request",
          category: "Pull Request",
          description: "Start a thread that walks through a pull request for a first-time reviewer.",
          keybindings: [],
          args: [slugArg, numberArg, worktreeArg, modelArg, effortArg],
        },
        when: always,
        run: start(false),
      },
      {
        cmd: {
          name: "pr.fix.findings",
          title: "Fix Pull Request Findings",
          category: "Pull Request",
          description: "Start a thread on the pull request's branch that fixes its unresolved review comments and failing checks.",
          keybindings: [],
          args: [slugArg, numberArg, worktreeArg, modelArg, effortArg],
        },
        when: always,
        run: start(true),
      },
    ];
  }

  /** The registry: definitions plus a `when` predicate over the caller's context. */
  private registry(): { cmd: CmdDef; when: (ctx: UiContext | undefined) => boolean; run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut> }[] {
    const activeTerm = (ctx: UiContext | undefined) => (ctx?.activeTerminalId ? this.terms.get(ctx.activeTerminalId) : undefined);
    const activeThread = (ctx: UiContext | undefined) => (ctx?.activeThreadId ? this.threads.get(ctx.activeThreadId) : undefined);
    const always = () => true;
    return [
      ...viewCommands((i) => this.emit(i)),
      ...this.logs.commands(),
      ...mcpCommands(this.logs, (i) => this.emit(i)),
      ...agentsCommands(this.logs, (i) => this.emit(i)),
      ...this.actions.commands(),
      {
        cmd: {
          name: "terminal.new",
          title: "New Terminal",
          category: "Terminal",
          description: "Start a shell that belongs to the active thread, else to the active worktree",
          keybindings: ["cmd+t"],
          args: [
            { name: "cwd", type: ArgType.PATH, required: false, description: "Working directory" },
            { name: "run", type: ArgType.STRING, required: false, description: "A command line typed into the new shell once it has printed its prompt, then Return" },
          ],
        },
        // Like the daemon: a thread, or a worktree to own the shell (never the dashboard or a page).
        when: (ctx) => Boolean(ctx?.activeThreadId || ctx?.activeWorktreePath),
        // Like the daemon: no focus intent; the result's JSON is the new terminal (the GUI
        // focuses it in the bottom panel by its id).
        run: async (ctx, args) => {
          const owner = this.shellOwner(ctx, args.cwd ?? "");
          const fail = this.terminalNewFail;
          this.terminalNewFail = null;
          if (this.terminalNewDelayMs > 0) await new Promise((r) => setTimeout(r, this.terminalNewDelayMs));
          if (fail !== null) throw new CommandError("unavailable", fail);
          const keys = runKeys(args.run ?? "");
          const t = this.create(["/bin/zsh"], owner.cwd, owner.labels, "shell");
          const resultJson = JSON.stringify({ id: t.id, cwd: t.cwd, labels: t.labels });
          if (keys === "") return { message: `created terminal ${t.id}`, resultJson };
          // Like the daemon: the shell is listed at once, and the command is typed once it
          // has printed its prompt (RUN_PROMPT_MS here), before the command returns.
          await new Promise((r) => setTimeout(r, RUN_PROMPT_MS));
          this.write(t.id, enc.encode(keys));
          return { message: `created terminal ${t.id} and ran the command in it`, resultJson };
        },
      },
      {
        cmd: {
          name: "thread.new",
          title: "New Thread",
          category: "Thread",
          description: "Start Claude Code in a worktree (or a new one), with a first prompt",
          keybindings: ["cmd+n"],
          args: [
            { name: "repo", type: ArgType.STRING, required: false, description: "Repository id" },
            { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree path" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name the thread belongs to" },
            { name: "repos", type: ArgType.STRING, required: false, description: "With new-worktree: repositories for a new workspace (repo[:base], comma-separated)" },
            { name: "model", type: ArgType.ENUM, required: false, description: "Model", enumValues: MODEL_VALUES, defaultValue: "claude-opus-4-8[1m]" },
            { name: "effort", type: ArgType.ENUM, required: false, description: "Effort", enumValues: ["low", "medium", "high", "xhigh", "max"], defaultValue: "high" },
            { name: "permission", type: ArgType.ENUM, required: false, description: "Permission mode", enumValues: ["supervised", "accept-edits", "auto"] },
            { name: "new-worktree", type: ArgType.BOOL, required: false, description: "Create a worktree for the thread" },
            { name: "no-project", type: ArgType.BOOL, required: false, description: "Start the thread without a project, in the home directory" },
            { name: "base", type: ArgType.STRING, required: false, description: "Base ref for the new worktree" },
            { name: "name", type: ArgType.STRING, required: false, description: "Thread name" },
            { name: "prompt", type: ArgType.STRING, required: false, description: "First prompt" },
            { name: "attachments", type: ArgType.STRING, required: false, description: "Staged attachment paths, comma-separated" },
            { name: "composer-prompt", type: ArgType.STRING, required: false, description: "The composer's text of prompt with its tag tokens" },
          ],
        },
        // Like the daemon: also in the composer, whose no-project target has no repo.
        when: (ctx) => this.worktreeOf(ctx) !== null || Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)) || ctx?.activeView === "compose",
        run: (ctx, args) => this.newThread(ctx, args),
      },
      {
        cmd: { name: "thread.fork", title: "Fork Thread", category: "Thread", description: "Start a new thread that continues this one's conversation", keybindings: [], args: [{ name: "name", type: ArgType.STRING, required: false, description: "Name for the fork" }] },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          const f = this.createThread(s.repoId, s.worktreePath, s.model, s.effort, { pendingName: `${s.name || s.id} (fork)`, permissionMode: s.permissionMode, parentId: s.id });
          this.logs.fork(s.id, f.id, s.name || s.id);
          this.focusThread(f.id);
          return `Forked ${s.name || s.id}`;
        },
      },
      {
        cmd: { name: "thread.rename", title: "Rename Thread", category: "Thread", description: "Set the thread's name", keybindings: ["cmd+r"], args: [{ name: "name", type: ArgType.STRING, required: true, description: "New name" }] },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          s.name = args.name ?? s.name;
          s.autoNamed = false;
          this.publishThread(s);
          return "";
        },
      },
      {
        cmd: {
          name: "thread.run-in",
          title: "Run Thread In…",
          category: "Thread",
          description: "Move a workspace thread to another member worktree of its workspace.",
          keybindings: [],
          args: [
            { name: "repo", type: ArgType.STRING, required: false, description: "Member repository (id or name)" },
            { name: "worktree", type: ArgType.PATH, required: false, description: "Member worktree path" },
          ],
        },
        // Like the daemon: the GUI passes the thread's workspace; the CLI (no view) names the thread.
        when: (ctx) => activeThread(ctx) !== undefined && Boolean(ctx?.activeWorkspaceId || !ctx?.activeView),
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          if (!args.repo && !args.worktree) throw new CommandError("invalid", "name the member: a repository or a worktree path");
          const out = this.runIn(s, args.repo ?? "", args.worktree ?? "");
          const label = out.name ? `${out.name} (${out.id})` : out.id;
          return out.pendingWorktreePath ? `thread ${label} moves to ${out.pendingWorktreePath} once it is idle` : `thread ${label} runs in ${out.worktreePath}`;
        },
      },
      {
        cmd: {
          name: "thread.pin",
          title: "Pin or Unpin Thread",
          category: "Thread",
          description: "Pin a thread to the top of the thread list, or unpin it. Without pinned, toggles the current pin.",
          keybindings: [],
          args: [{ name: "pinned", type: ArgType.BOOL, required: false, description: "Pin (true) or unpin (false)" }],
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          s.pinned = args.pinned === undefined || args.pinned === "" ? !s.pinned : args.pinned === "true";
          if (s.pinned) {
            s.archivedAt = null;
            s.snoozedUntil = null;
          }
          this.publishThread(s);
          return `${s.pinned ? "pinned" : "unpinned"} thread ${s.name ? `${s.name} (${s.id})` : s.id}`;
        },
      },
      {
        cmd: {
          name: "workspace.add-repo",
          title: "Add Project to Workspace",
          category: "Workspace",
          description: "Create a worktree on the workspace branch in another repository and add it to the workspace.",
          keybindings: [],
          args: [
            { name: "repo", type: ArgType.STRING, required: true, description: "Repository id, name, or absolute path" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name" },
            { name: "base", type: ArgType.STRING, required: false, description: "Ref to branch from" },
          ],
        },
        when: always,
        run: (_ctx, args) => {
          const ws = this.addWorkspaceRepo(args.workspace ?? "", args.repo ?? "", args.base ?? "");
          const last = ws.members[ws.members.length - 1];
          return `added ${args.repo ?? ""} to workspace ${ws.name}: ${last?.worktreePath ?? ""} on ${ws.branch}`;
        },
      },
      {
        cmd: {
          name: "workspace.remove-repo",
          title: "Remove Project from Workspace",
          category: "Workspace",
          description: "Delete a member repository's worktree and drop it from the workspace.",
          keybindings: [],
          args: [
            { name: "repo", type: ArgType.STRING, required: true, description: "Repository id, name, or path" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name" },
            { name: "force", type: ArgType.BOOL, required: false, description: "Remove even with uncommitted changes" },
          ],
          confirm: (_ctx, args) => `Remove project ${args.repo ?? ""} from its workspace? This deletes its worktree from disk.`,
        },
        when: always,
        run: (_ctx, args) => {
          const ws = this.removeWorkspaceRepo(args.workspace ?? "", args.repo ?? "", args.force === "true");
          return `removed ${args.repo ?? ""} from workspace ${ws.name} (${String(ws.members.length)} left)`;
        },
      },
      {
        cmd: {
          name: "workspace.remove",
          title: "Remove Workspace",
          category: "Workspace",
          description: "Delete every member worktree and forget the workspace.",
          keybindings: [],
          args: [
            { name: "workspace", type: ArgType.STRING, required: true, description: "Workspace id or name" },
            { name: "force", type: ArgType.BOOL, required: false, description: "Remove even with uncommitted changes" },
          ],
          confirm: (_ctx, args) => `Remove workspace ${args.workspace ?? ""}? This deletes every member worktree from disk.`,
        },
        when: always,
        run: (_ctx, args) => {
          this.removeWorkspace(args.workspace ?? "", args.force === "true");
          return `removed workspace ${args.workspace ?? ""}`;
        },
      },
      {
        cmd: {
          name: "thread.archive",
          title: "Archive or Unarchive Thread",
          category: "Thread",
          description:
            "Archive a thread: Claude is closed, its terminals are removed and it is unpinned and listed apart. Unarchive puts it back in the thread list. Without archived, toggles. Pinning or sending a message unarchives a thread too.",
          keybindings: [],
          args: [{ name: "archived", type: ArgType.BOOL, required: false, description: "Archive (true) or unarchive (false); default: the opposite of now" }],
          // Like the daemon: only archiving a thread that is mid-turn or running background work asks.
          confirmIf: (ctx, args) => {
            const s = activeThread(ctx);
            return s !== undefined && archiving(s, args) && this.interrupts(s).why !== "";
          },
          confirm: (ctx) => {
            const s = activeThread(ctx);
            const { why, ends } = s ? this.interrupts(s) : { why: "", ends: "" };
            return `Archive thread ${s?.name || (s?.id ?? "")}? ${why}; archiving ${ends}.`;
          },
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          return this.archiveThread(s.id, archiving(s, args));
        },
      },
      {
        cmd: {
          name: "thread.snooze",
          title: "Snooze or Unsnooze Thread",
          category: "Thread",
          description:
            "Snooze a thread until a time: Claude is closed, its terminals are removed and it is unpinned and listed apart; when the time comes it returns needing attention (\"snooze ended\"). clear unsnoozes. Pinning, archiving or sending a message unsnoozes a thread too.",
          keybindings: [],
          args: [
            { name: "until", type: ArgType.STRING, required: false, description: "When the thread wakes: 1h, 90m, tomorrow, next-week, mon..sun, 2026-10-20, 2026-10-20 14:00 or RFC 3339" },
            { name: "clear", type: ArgType.BOOL, required: false, description: "Unsnooze the thread instead" },
          ],
          // Like the daemon: only snoozing (a valid time) a thread that is mid-turn asks.
          confirmIf: (ctx, args) => {
            const s = activeThread(ctx);
            if (s === undefined || args.clear === "true" || this.interrupts(s).why === "") return false;
            try {
              return snoozeUntil(args) !== null;
            } catch {
              return false;
            }
          },
          confirm: (ctx) => {
            const s = activeThread(ctx);
            const { why, ends } = s ? this.interrupts(s) : { why: "", ends: "" };
            return `Snooze thread ${s?.name || (s?.id ?? "")}? ${why}; snoozing ${ends}.`;
          },
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          return this.snoozeThread(s.id, snoozeUntil(args));
        },
      },
      {
        cmd: {
          name: "thread.remove", title: "Remove Thread", category: "Thread", description: "Forget the thread (closes it first if connected)", keybindings: [], args: [],
          confirm: (ctx) => `Remove thread ${ctx?.activeThreadId ?? ""}? It is closed first if connected, and its row is forgotten.`,
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          if (s.state !== ThreadState.DISCONNECTED) this.stopThread(s.id, "closed", 0);
          this.closeShells((l) => l[LABEL_THREAD] === s.id);
          this.actions.stopBackground((r) => r.threadId === s.id);
          this.threads.delete(s.id);
          this.threadListEvents.publish({ event: { case: "removedId", value: s.id } });
          return `Removed ${s.name || s.id}`;
        },
      },
      {
        cmd: {
          name: "terminal.kill", title: "Kill Terminal", category: "Terminal", description: "Send SIGHUP to the active terminal", keybindings: ["cmd+alt+w"],
          // --id defaults to the active terminal, like the daemon (context-bound; invoke puts it in the context).
          args: [{ name: "id", type: ArgType.STRING, required: false, description: "Terminal id (default: the active terminal)" }],
          confirm: (ctx, args) => `Kill terminal ${args.id || (ctx?.activeTerminalId ?? "")}? Its process is terminated.`,
        },
        when: (ctx) => activeTerm(ctx)?.state === TerminalState.RUNNING,
        run: (ctx, args) => {
          const t = args.id ? this.term(args.id) : activeTerm(ctx);
          if (!t) throw new CommandError("unavailable", "no active terminal");
          // An action run that ignores SIGHUP ends with SIGKILL after the grace period, like the daemon's.
          const grace = this.actions.hangupGraceMs(t.id);
          if (grace > 0) {
            setTimeout(() => {
              if (this.terms.has(t.id)) this.kill(t.id, 137);
            }, grace);
            return `Killed ${t.id}`;
          }
          this.kill(t.id);
          return `Killed ${t.id}`;
        },
      },
      {
        // --id defaults to the active terminal, like the daemon (a context-bound arg, so not required in List).
        cmd: { name: "terminal.close", title: "Close Terminal", category: "Terminal", description: "Terminate the terminal's process and remove it once it has exited", keybindings: [], args: [{ name: "id", type: ArgType.STRING, required: false, description: "Terminal id (default: the active terminal)" }] },
        // Only shells and action runs, like the daemon.
        when: (ctx) => {
          const t = activeTerm(ctx);
          return t !== undefined && isPanel(t.labels);
        },
        run: (ctx, args) => {
          const id = args.id || activeTerm(ctx)?.id;
          if (!id) throw new CommandError("unavailable", "no active terminal");
          this.close(id);
          return `closed terminal ${id}`;
        },
      },
      {
        cmd: { name: "terminal.remove", title: "Remove Exited Terminal", category: "Terminal", description: "Forget the active terminal", keybindings: [], args: [] },
        when: (ctx) => activeTerm(ctx)?.state === TerminalState.EXITED,
        run: (ctx) => {
          const t = activeTerm(ctx);
          if (!t) throw new CommandError("unavailable", "no active terminal");
          this.remove(t.id);
          return `Removed ${t.id}`;
        },
      },
      {
        cmd: { name: "terminal.focus", title: "Focus Terminal…", category: "Terminal", description: "Show a terminal by id", keybindings: [], args: [{ name: "terminal_id", type: ArgType.ENUM, required: true, description: "Terminal", enumValues: [...this.terms.keys()] }] },
        when: () => this.terms.size > 0,
        run: (_ctx, args) => {
          const t = this.term(args.terminal_id ?? "");
          this.intents.publish({ intent: { case: "focusTerminal", value: { terminalId: t.id } } });
          return "";
        },
      },
      {
        cmd: {
          name: "repo.add",
          title: "Add Project",
          category: "Project",
          description: "Add a project: start a new one, add a folder on this Mac, or clone a repository from GitHub. Opens the Add Project dialog in the app.",
          keybindings: [],
          args: [{ name: "path", type: ArgType.PATH, required: false, description: "Project folder to add without the dialog (a git repository or any folder under home)" }],
        },
        when: always,
        // The GUI presents it (the dialog); this is the CLI's answer, like the daemon.
        run: (_ctx, args) => {
          if (!args.path) return "Add a project from the CLI with `code-foundry repo add <folder>` or `code-foundry repo clone <owner/repo>`; in the app, repo.add opens the Add Project dialog.";
          const repo = this.registerFolder(args.path);
          return Promise.resolve({ message: `registered ${repo.name} (${repo.id})`, resultJson: JSON.stringify(this.repoMsg(repo)) });
        },
      },
      {
        cmd: {
          name: "repo.clone",
          title: "Clone from GitHub",
          category: "Project",
          description: "Clone a github.com repository with `gh repo clone` into ~/.code-foundry/projects/<owner>/<repo> and add it as a project.",
          keybindings: [],
          args: [{ name: "repo", type: ArgType.STRING, required: true, description: "owner/repo or https://github.com/owner/repo" }],
        },
        when: always,
        run: () => {
          throw new CommandError("unavailable", "the mock clones through RepoService.Clone (the Add Project dialog)");
        },
      },
      {
        cmd: {
          name: "repo.unregister", title: "Remove Project", category: "Project", description: "Stop tracking the active project", keybindings: [], args: [],
          confirm: (ctx) => `Stop tracking project ${ctx?.activeRepoId ?? ""}? Nothing on disk is touched.`,
        },
        when: (ctx) => Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)),
        run: (ctx) => {
          const id = ctx?.activeRepoId ?? "";
          this.repos.delete(id);
          this.repoEvents.publish({ event: { case: "repoRemovedId", value: id } });
          return `Unregistered ${id}`;
        },
      },
      {
        cmd: {
          name: "repo.git.init",
          title: "Initialize Git",
          category: "Project",
          description: "Make a project without git a git repository: git init on the default branch (init.defaultBranch, else main) and an empty initial commit, so worktrees can branch from it.",
          keybindings: [],
          args: [{ name: "repo", type: ArgType.STRING, required: false, description: "Repository id (default: the active repository)" }],
        },
        // Like the daemon: a project is active and it is not a git repository.
        when: (ctx) => this.repos.get(ctx?.activeRepoId ?? "")?.git === false,
        run: (ctx, args) => {
          const repo = this.initGit(args.repo || ctx?.activeRepoId || "");
          return `initialized git in ${repo.name} on ${repo.defaultBranch}`;
        },
      },
      {
        cmd: {
          name: "repo.refresh", title: "Refresh Git Status", category: "Repository", description: "Reconcile git status now", keybindings: ["cmd+alt+r"],
          args: [{ name: "repo", type: ArgType.STRING, required: false, description: "Repository id (default: all)" }],
        },
        when: always,
        run: (_ctx, args) => {
          for (const r of this.repos.values()) if (!args.repo || args.repo === r.id) this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(r) } });
          return args.repo ? `refreshed ${args.repo}` : "Git status refreshed";
        },
      },
      {
        // As internal/command/commands_repo.go: repo (context), branch (prompted), base, fetch.
        cmd: {
          name: "repo.worktree.new",
          title: "New Worktree",
          category: "Project",
          description: "Create a worktree for a branch, creating the branch from base when it does not exist.",
          keybindings: [],
          args: [
            { name: "repo", type: ArgType.STRING, required: false, description: "Repository id (default: the active repository)" },
            { name: "branch", type: ArgType.STRING, required: true, description: "Branch to check out" },
            { name: "base", type: ArgType.STRING, required: false, description: "Ref to branch from (default: the default branch)" },
            { name: "fetch", type: ArgType.BOOL, required: false, description: "Fetch the remote base branch first", defaultValue: "true" },
          ],
        },
        when: (ctx) => this.repos.get(ctx?.activeRepoId ?? "")?.git !== false && Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)),
        run: (ctx, args) => {
          const repo = this.repos.get(args.repo || ctx?.activeRepoId || "");
          if (!repo) throw new CommandError("unavailable", "no active repository");
          requireGit(repo, "a new worktree");
          const branch = args.branch ?? "";
          const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${repo.githubSlug || `_local/${repo.name}`}/${branch.replace(/\//g, "-")}`, branch, head: "c0ffee00", isMain: false, status: clean({ upstream: "", baseRef: "" }) };
          repo.worktrees.push(w);
          this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
          return `created worktree ${w.path} on ${branch}`;
        },
      },
      {
        cmd: {
          name: "worktree.create",
          title: "Create Worktree",
          category: "Worktree",
          description: "New worktree for a branch in the active repository",
          keybindings: [],
          args: [
            { name: "branch", type: ArgType.STRING, required: true, description: "Branch name" },
            { name: "base_ref", type: ArgType.STRING, required: false, description: "Base ref" },
          ],
        },
        when: (ctx) => this.repos.get(ctx?.activeRepoId ?? "")?.git !== false && Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)),
        run: (ctx, args) => {
          const repo = this.repos.get(ctx?.activeRepoId ?? "");
          if (!repo) throw new CommandError("unavailable", "no active repository");
          requireGit(repo, "a new worktree");
          const branch = args.branch ?? "";
          const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${repo.githubSlug || `_local/${repo.name}`}/${branch.replace(/\//g, "-")}`, branch, head: "c0ffee00", isMain: false, status: clean({ upstream: "", baseRef: "" }) };
          repo.worktrees.push(w);
          this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
          this.intents.publish({ intent: { case: "focusRepo", value: { repoId: repo.id, worktreePath: w.path } } });
          return `Created worktree ${branch}`;
        },
      },
      {
        cmd: {
          name: "repo.worktree.remove", title: "Remove Worktree", category: "Worktree", description: "Remove the active worktree", keybindings: [],
          args: [{ name: "force", type: ArgType.BOOL, required: false, description: "Remove even with uncommitted changes" }],
          confirm: (ctx) => `Remove worktree ${ctx?.activeWorktreePath ?? ""}? This deletes files on disk.`,
        },
        when: (ctx) => {
          const w = this.worktreeOf(ctx);
          return w !== null && !w.wt.isMain;
        },
        run: (ctx, args) => {
          const w = this.worktreeOf(ctx);
          if (!w) throw new CommandError("unavailable", "no active worktree");
          if (w.wt.status.dirty && args.force !== "true") throw new CommandError("unavailable", "worktree has local changes; use force");
          this.dropWorktree(w.wt.path);
          return `Removed worktree ${w.wt.branch}`;
        },
      },
      {
        // As internal/command/commands_repo_cleanup.go (the fetch is not modelled).
        cmd: {
          name: "repo.worktree.cleanup",
          title: "Clean Up Merged Worktrees",
          category: "Project",
          description: "Fetch, then remove the project's worktrees (or one) whose work is already in origin/<default>. Branches are kept.",
          keybindings: [],
          args: [
            { name: "repo", type: ArgType.STRING, required: true, description: "Repository name or id" },
            { name: "path", type: ArgType.PATH, required: false, description: "One worktree (default: every merged one)" },
          ],
          confirm: (ctx, args) => {
            const ref = args.repo || ctx?.activeRepoId || "";
            const rm = this.cleanupWorktrees(ref, args.path ?? "", true).removed;
            if (rm.length === 0) return `Fetch ${ref} and remove the worktrees created by Code Foundry (under its worktrees directory) whose work is already in the default branch? Branches are kept.`;
            if (args.path) return `Remove the worktree of ${rm[0]?.branch ?? ""} (${args.path})? Code Foundry created it (under its worktrees directory) and its work is in origin/main; the branch is kept. It is checked again after a fetch.`;
            return `Remove ${String(rm.length)} ${rm.length === 1 ? "worktree" : "worktrees"} created by Code Foundry (under its worktrees directory) whose work is in origin/main: ${rm.map((w) => w.branch).join(", ")}? Branches are kept; each is checked again after a fetch.`;
          },
        },
        when: (ctx) => Boolean(ctx?.activeRepoId && this.repos.get(ctx.activeRepoId)?.git !== false),
        run: (ctx, args) => {
          const res = this.cleanupWorktrees(args.repo || ctx?.activeRepoId || "", args.path ?? "", false);
          const parts: string[] = [];
          const n = (k: number) => `${String(k)} ${k === 1 ? "worktree" : "worktrees"}`;
          if (res.removed.length > 0) parts.push(`Removed ${n(res.removed.length)}: ${res.removed.map((w) => w.branch).join(", ")}`);
          if (res.skipped.length > 0) parts.push(`${res.removed.length === 0 ? "Nothing removed; kept" : "kept"} ${n(res.skipped.length)}: ${res.skipped.map((s) => `${s.w.branch} (${s.reason})`).join(", ")}`);
          return parts.join("; ") || "No worktrees to clean up";
        },
      },
      {
        cmd: { name: "ui.palette.open", title: "Open Command Palette", category: "View", description: "Open the command palette in every connected window", keybindings: [], args: [{ name: "query", type: ArgType.STRING, required: false, description: "Text to pre-fill" }] },
        when: always,
        run: (_ctx, args) => `delivered=${String(this.emit({ intent: { case: "openPalette", value: { query: args.query ?? "" } } }))}`,
      },
      {
        cmd: { name: "ui.notify", title: "Send Test Notification", category: "Developer", description: "Emit a Notify intent", keybindings: [], args: [{ name: "level", type: ArgType.ENUM, required: true, description: "Level", enumValues: ["info", "warning", "error"], defaultValue: "info" }] },
        when: always,
        run: (_ctx, args) => {
          const levels: Record<string, UiIntent_Notify_Level> = { info: UiIntent_Notify_Level.INFO, warning: UiIntent_Notify_Level.WARNING, error: UiIntent_Notify_Level.ERROR };
          const level = levels[args.level ?? "info"] ?? UiIntent_Notify_Level.INFO;
          this.intents.publish({ intent: { case: "notify", value: { level, title: `Test ${args.level ?? "info"}`, body: "Sent from the mock daemon" } } });
          return "";
        },
      },
      {
        // Mock-only: no daemon command prompts for a path in the palette (context-bound
        // paths are sent as not required), so e2e/paths.spec.ts drives the prompt with this.
        cmd: { name: "dev.path", title: "Echo Path", category: "Developer", description: "Report a folder (the palette's path prompt)", keybindings: [], args: [{ name: "path", type: ArgType.PATH, required: true, description: "Folder" }] },
        when: always,
        run: (_ctx, args) => `path ${args.path ?? ""}`,
      },
      {
        cmd: { name: "daemon.status", title: "Daemon Status", category: "Daemon", description: "Show pid and uptime", keybindings: [], args: [] },
        when: always,
        run: () => `mock daemon pid ${String(process.pid)}, up ${String(Math.round((Date.now() - this.startedAt) / 1000))}s`,
      },
      ...this.gitops.entries((path) => {
        for (const repo of this.repos.values()) {
          const wt = repo.worktrees.find((w) => w.path === path);
          if (wt) return { repoId: repo.id, path: wt.path, branch: wt.branch, githubSlug: repo.githubSlug, hasRemote: repo.remotes.length > 0 };
        }
        return null;
      }),
      ...this.gh.prDetails.commands(),
      ...this.prThreadCommands(),
      ...projectCommands(this),
      {
        cmd: { name: "view.settings", title: "Settings", category: "View", description: "Show the settings page, or close it where it already shows", keybindings: ["cmd+,"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "settings" } } }))}`,
      },
      {
        cmd: { name: "view.usage", title: "Usage", category: "View", description: "Show the Usage page: token usage and its cost per day and per model over every thread.", keybindings: [], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "usage" } } }))}`,
      },
      {
        cmd: { name: "view.help", title: "Keyboard Shortcuts and Help", category: "View", description: "Show keybindings and how the app works", keybindings: ["cmd+/"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "help" } } }))}`,
      },
      {
        cmd: { name: "view.panel.toggle", title: "Toggle Side Panel", category: "View", description: "Show or hide the side panel next to the selected thread or page.", keybindings: ["cmd+shift+e"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.toggle" } } }))}`,
      },
      {
        cmd: { name: "view.bottom.toggle", title: "Toggle Bottom Panel", category: "View", description: "Show or hide the terminals under the selected thread or page. In the app, opening it with no terminal starts a shell.", keybindings: ["cmd+j"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "bottom.toggle" } } }))}`,
      },
      {
        cmd: { name: "view.panel.expand", title: "Expand Side Panel", category: "View", description: "Toggle the side panel between its split width and the full width of the content area for the selected thread or page.", keybindings: [], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.expand" } } }))}`,
      },
      {
        cmd: { name: "view.panel.new-tab", title: "New Side Panel Tab", category: "View", description: "Show the surface list in the side panel of the selected thread or page, to open another tab there.", keybindings: [], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.new-tab" } } }))}`,
      },
      {
        cmd: {
          name: "view.panel.workspace",
          title: "Show Workspace in Side Panel",
          category: "View",
          description: "Open the workspace surface in the selected workspace thread's side panel: its members with branch, changes, ahead/behind and pull request, add and remove members, Run in.",
          keybindings: [],
          args: [],
        },
        // Like the daemon: a thread is active and it belongs to a workspace.
        when: (ctx) => Boolean(ctx?.activeThreadId && ctx.activeWorkspaceId),
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.workspace" } } }))}`,
      },
      {
        cmd: {
          name: "view.panel.worktree",
          title: "Show Worktree in Side Panel",
          category: "View",
          description: "Open the Worktree surface in the selected thread's side panel: the overview of the worktree it runs in, with sync state, GitHub activity, changed files and log.",
          keybindings: [],
          args: [],
        },
        // Like the daemon: a thread is active and it sits in a registered worktree.
        when: (ctx) => Boolean(ctx?.activeThreadId && ctx.activeRepoId && ctx.activeWorktreePath),
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.worktree" } } }))}`,
      },
      {
        cmd: {
          name: "view.panel.linked-prs",
          title: "Show Linked PRs in Side Panel",
          category: "View",
          description: "Open the Linked PRs surface in the selected thread's side panel: the pull requests the thread created or touched, newest first, with state, checks and branch.",
          keybindings: [],
          args: [],
        },
        // Like the daemon: a thread is active (with or without linked pull requests).
        when: (ctx) => Boolean(ctx?.activeThreadId),
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.linked-prs" } } }))}`,
      },
      {
        cmd: {
          name: "view.panel.usage",
          title: "Show Usage in Side Panel",
          category: "View",
          description: "Open the Usage surface in the selected thread's side panel: its cost at Claude API rates, tokens and requests, per model and per token kind.",
          keybindings: [],
          args: [],
        },
        // Like the daemon: a thread is active (with or without usage).
        when: (ctx) => Boolean(ctx?.activeThreadId),
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.usage" } } }))}`,
      },
      {
        cmd: { name: "settings.reveal", title: "Reveal Settings File", category: "Settings", description: "Show the settings file in Finder", keybindings: [], args: [] },
        when: always,
        run: () => "revealed settings.toml",
      },
      {
        cmd: { name: "settings.path", title: "Settings File Path", category: "Settings", description: "Print the settings file's path", keybindings: [], args: [] },
        when: always,
        run: () => this.settings.snapshot().path ?? "",
      },
      {
        cmd: {
          name: "notifications.test",
          title: "Notifications: Play Alert Sound",
          category: "Settings",
          description: "Play the alert sound at the current volume.",
          keybindings: [],
          args: [{ name: "volume", type: ArgType.INT, required: false, description: "Volume in percent of the Mac's output volume, 0–100 (default: the notifications.sound_volume setting)" }],
        },
        when: always,
        // Like the daemon: the explicit volume, else the setting. The browser has no host to play it.
        run: (_ctx, args) => {
          const volume = Number(args.volume ?? this.settings.values()["notifications.sound_volume"] ?? 50);
          const n = this.emit({ intent: { case: "playAlertSound", value: { volume } } });
          return `alert sound at ${String(volume)}%: delivered=${String(n)}`;
        },
      },
      // Like internal/command/commands_theme.go.
      {
        cmd: { name: "theme.list", title: "List Themes", category: "Settings", description: "Print every colour theme by scheme, marking the dark and light themes in use.", keybindings: [], args: [] },
        when: always,
        run: () => {
          const v = this.settings.values();
          return (["dark", "light"] as const)
            .map((s) => `${s} themes:\n` + themesFor(s).map((t) => `${t.id === v[`appearance.theme_${s}`] ? "*" : " "} ${t.id}  ${t.name}`).join("\n"))
            .join("\n\n");
        },
      },
      ...(["dark", "light"] as const).map((scheme) => ({
        cmd: {
          name: `theme.set-${scheme}`,
          title: `Set ${scheme === "dark" ? "Dark" : "Light"} Theme`,
          category: "Settings",
          description: `Choose the theme used when the scheme is ${scheme}.`,
          keybindings: [],
          args: [{ name: "theme", type: ArgType.ENUM, required: true, description: `A ${scheme} theme id`, enumValues: themesFor(scheme).map((t) => t.id) }],
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          this.settings.update({ [`appearance.theme_${scheme}`]: args.theme ?? "" });
          return `${scheme} theme = ${args.theme ?? ""}`;
        },
      })),
      // Like internal/command/commands_theme_pick.go: the Themes page, optionally on a slot.
      {
        cmd: {
          name: "theme.pick",
          title: "Choose Theme…",
          category: "Settings",
          description: "Open the Themes page: preview each theme in a gallery of the app's controls, then apply it to the dark or light slot.",
          keybindings: [],
          args: [{ name: "slot", type: ArgType.ENUM, required: false, description: "The slot to edit first (default: the one in use)", enumValues: ["dark", "light"] }],
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          const name = args.slot ? `themes.${args.slot}` : "themes";
          return `delivered=${String(this.emit({ intent: { case: "showView", value: { name } } }))}`;
        },
      },
      ...this.update.commands(),
    ];
  }

  /** The registry with settings applied: keybinding overrides and thread.new defaults. */
  /** threads.default_model and threads.default_effort ("" when unset). */
  private threadDefaults(): { model: string; effort: string } {
    const v = this.settings.values();
    return { model: v["threads.default_model"] ?? "", effort: v["threads.default_effort"] ?? "" };
  }

  /**
   * The registry with settings applied: keybinding overrides, and the thread defaults on
   * every command that starts a thread (internal/daemon/settings.go registryOverrides).
   */
  private effectiveRegistry(): ReturnType<World["registry"]> {
    const entries = this.registry();
    const kb = this.settings.keybindings();
    const defaults: Record<string, string> = this.threadDefaults();
    const startsThread = new Set(["thread.new", "pr.ask", "pr.explain", "pr.fix.findings"]);
    return entries.map((e) => ({
      ...e,
      cmd: {
        ...e.cmd,
        keybindings: kb[e.cmd.name] ?? e.cmd.keybindings,
        args: e.cmd.args.map((a) => {
          const d = startsThread.has(e.cmd.name) && (a.name === "model" || a.name === "effort") ? defaults[a.name] : "";
          return d && a.enumValues?.includes(d) ? { ...a, defaultValue: d } : a;
        }),
      },
    }));
  }

  listCommands(ctx: UiContext | undefined, includeUnavailable: boolean): (Omit<CmdDef, "confirm" | "confirmIf"> & { available: boolean; requiresConfirmation: boolean })[] {
    return this.effectiveRegistry()
      .map(({ cmd: { confirm, confirmIf: _if, ...cmd }, when }) => ({ ...cmd, available: when(ctx), requiresConfirmation: confirm !== undefined }))
      .filter((c) => includeUnavailable || c.available);
  }

  invoke(name: string, ctx: UiContext | undefined, args: Record<string, string>, confirmed = false): string | Promise<InvokeOut> {
    const entry = this.effectiveRegistry().find((e) => e.cmd.name === name);
    this.invocations.push({
      name,
      context: ctx
        ? {
            activeTerminalId: ctx.activeTerminalId,
            activeThreadId: ctx.activeThreadId,
            activeRepoId: ctx.activeRepoId,
            activeWorktreePath: ctx.activeWorktreePath,
            activeView: ctx.activeView,
            activeWorkspaceId: ctx.activeWorkspaceId,
          }
        : null,
      args,
      confirmed,
      at: new Date().toISOString(),
    });
    if (!entry) throw new CommandError("notfound", `unknown command ${name}`);
    // Like the daemon's context-bound args: an explicit worktree stands in for the context's.
    let whenCtx = args.worktree ? ({ ...ctx, activeWorktreePath: args.worktree } as UiContext) : ctx;
    // A terminal command's --id stands in for the context's terminal the same way.
    if (name.startsWith("terminal.") && args.id) whenCtx = { ...whenCtx, activeTerminalId: args.id } as UiContext;
    if (!entry.when(whenCtx)) throw new CommandError("unavailable", `${name} is not available here`);
    for (const a of entry.cmd.args) {
      if (a.required && !args[a.name]) throw new CommandError("invalid", `missing required arg ${a.name}`);
    }
    if (entry.cmd.confirm && !confirmed && (entry.cmd.confirmIf?.(ctx, args) ?? true)) throw new ConfirmNeeded(name, entry.cmd.title, entry.cmd.confirm(ctx, args));
    return entry.run(ctx, args);
  }
}
