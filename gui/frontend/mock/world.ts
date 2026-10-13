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
import { PermissionMode, SessionState, SessionStatus, type SessionEventSchema, type SessionSchema } from "../src/gen/codefoundry/v1/session_pb";
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
import { MockUpdater } from "./update";
import { pageUsage, retiredUsage, sampleUsage, usageFields, type MockUsage } from "./usage";
import { ENTER_ALT, prompt, RESET, topFrame } from "./screens";
import { CommandError } from "./errors";
import { mcpCommands } from "./mcp";
import { CRASH_STDERR, MockThreads, type SeedHistory, type ThreadState } from "./thread";
import { contextFields, recordResult, type MockContext } from "./context";

type TerminalInit = MessageInitShape<typeof TerminalSchema>;
type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;
type TerminalEventInit = MessageInitShape<typeof TerminalEventSchema>;
type RepoInit = MessageInitShape<typeof RepoSchema>;
type WorktreeInit = MessageInitShape<typeof WorktreeSchema>;
type RepoEventInit = MessageInitShape<typeof RepoEventSchema>;
type SessionInit = MessageInitShape<typeof SessionSchema>;
type SessionEventInit = MessageInitShape<typeof SessionEventSchema>;
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

interface MockSession {
  id: string;
  claudeSessionId: string;
  repoId: string;
  worktreePath: string;
  name: string;
  autoNamed: boolean;
  model: string;
  effort: string;
  state: SessionState;
  /** Persisted like the daemon's: a disconnected thread keeps it (busy becomes ERROR "interrupted"). */
  status: SessionStatus;
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
  /** session.fork: the session this one was forked from. */
  parentId: string;
  permissionMode: PermissionMode;
  baseRef: string;
  createdWorktree: boolean;
  /** The owning workspace; "" for a project thread. */
  workspaceId: string;
  /** A queued session.run-in target; "" when none (published, not "persisted"). */
  pendingWorktreePath: string;
  /** session.pin. */
  pinned: boolean;
  /** An effort change waiting for the turn to end (thread.set-effort). */
  effortPending: boolean;
  /** Mock-only: a new thread's first message, sent once it connects (the daemon sends it after the handshake). */
  firstMessage: { text: string; attachments: string[]; composerText: string } | null;
  /** Claude's pr-link records: one per URL, first-seen order (POST /__mock/link-pr). */
  linkedPullRequests: { slug: string; number: number; url: string; linkedAt: Date }[];
  /** Token usage buckets (mock/usage.ts; POST /__mock/usage). */
  usage: MockUsage[];
  /** The thread's context totals (mock/context.ts). */
  contextTokens: MockContext["contextTokens"];
  contextModel: MockContext["contextModel"];
  lastResultAt: MockContext["lastResultAt"];
  /** Mock-only: seconds a queued run-in waits once the thread is not busy (the daemon waits for its prompt). */
  moveIn: number;
  /** Mock-only: seconds left before a STARTING/CLOSING session settles. */
  settleIn: number;
  /** Mock-only: seconds until an unnamed session gets `pendingName` (background naming). */
  nameIn: number;
  pendingName: string;
  /**
   * Mock-only: the clock leaves it alone (no settling, no busy/idle flip, no naming, no
   * queued move); POST /__mock/session/hold. Specs that pin the sidebar order use it, since
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
}
export type UiIntentInit = MessageInitShape<typeof UiIntentSchema>;

type Kind = "top" | "shell";

// The terminal label contract (internal/termlabel, proto Terminal.labels).
const LABEL_KIND = "kind";
const LABEL_SESSION = "session";
const LABEL_REPO = "repo";
const LABEL_WORKTREE = "worktree";
const KIND_SHELL = "shell";

/** Labels of a shell terminal.new starts: owned by a worktree, and by a thread when sessionId is set. */
function shellLabels(sessionId: string, repoId: string, worktree: string): Record<string, string> {
  const l: Record<string, string> = { [LABEL_KIND]: KIND_SHELL, [LABEL_REPO]: repoId, [LABEL_WORKTREE]: worktree };
  if (sessionId) l[LABEL_SESSION] = sessionId;
  return l;
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
  status: { upstream: string; ahead: number; behind: number; staged: number; modified: number; untracked: number; dirty: boolean; baseRef?: string; baseAhead?: number; baseBehind?: number };
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

/** session.new's `permission` arg values. */
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

/** A typical detector reason for a status (captured strings; see src/lib/session.test.ts). */
function defaultReason(status: SessionStatus): string {
  switch (status) {
    case SessionStatus.BUSY:
      return "working";
    case SessionStatus.IDLE:
      return "at prompt";
    case SessionStatus.NEEDS_ATTENTION:
      return "permission: Do you want to proceed?";
    case SessionStatus.ERROR:
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
 * session.new's first message: its prompt (and attachments), sent once the thread has
 * connected, with the composer's text for display. null without either.
 */
function firstMessageOf(args: Record<string, string>): MockSession["firstMessage"] {
  const text = (args.prompt ?? "").trim();
  const attachments = (args.attachments ?? "").split(",").filter(Boolean);
  return text || attachments.length > 0 ? { text, attachments, composerText: args["composer-prompt"] ?? "" } : null;
}

/**
 * The default world's thread histories (MockThreads.seed), so every thread's timeline has
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
  sessions = new Map<string, MockSession>();
  workspaces = new Map<string, MockWorkspace>();
  /** EventService: every hub below tees into this one, so its order is publish order. */
  readonly events = new Hub<{ source: EventSource; event: EventInit }>();
  readonly termEvents = new Hub<TerminalEventInit>((v) => this.events.publish({ source: EventSource.TERMINAL, event: { event: { case: "terminal", value: v } } }));
  readonly repoEvents = new Hub<RepoEventInit>((v) => this.events.publish({ source: EventSource.REPO, event: { event: { case: "repo", value: v } } }));
  readonly workspaceEvents = new Hub<WorkspaceEventInit>((v) => this.events.publish({ source: EventSource.WORKSPACE, event: { event: { case: "workspace", value: v } } }));
  readonly sessionEvents = new Hub<SessionEventInit>((v) => this.events.publish({ source: EventSource.SESSION, event: { event: { case: "session", value: v } } }));
  readonly intents = new Hub<UiIntentInit>((v) => this.events.publish({ source: EventSource.UI, event: { event: { case: "ui", value: v } } }));
  readonly gitopsEvents = new Hub<GitOpsEventInit>((v) => this.events.publish({ source: EventSource.GITOPS, event: { event: { case: "gitops", value: v } } }));
  /** Threads' conversations (mock/thread.ts); the EventService thread source carries their pending requests. */
  readonly threads = new MockThreads(
    {
      worktreeOf: (id) => this.session(id).worktreePath,
      modelOf: (id) => this.session(id).model,
      isConnected: (id) => this.session(id).state === SessionState.CONNECTED,
      setStatus: (id, status, reason) => {
        const s = this.session(id);
        this.setStatus(s, status, reason);
        s.lastActivityAt = new Date();
        this.publishSession(s);
      },
      setModel: (id, model) => {
        const s = this.session(id);
        s.model = model;
        this.publishSession(s);
      },
      setPermission: (id, permission) => {
        const s = this.session(id);
        s.permissionMode = permissionModes[permission] ?? s.permissionMode;
        this.publishSession(s);
      },
      setEffort: (id, effort, pending) => {
        const s = this.session(id);
        s.effort = effort;
        s.effortPending = pending;
        this.publishSession(s);
      },
      statusOf: (id) => this.session(id).status,
      recordResult: (id, model) => {
        const s = this.session(id);
        recordResult(s, model);
        this.publishSession(s);
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
      for (const s of this.sessions.values()) if (s.lastResultAt) this.publishSession(s);
    },
  );
  /** UpdateService (Phase 3d): publishes into the events hub as the update source. */
  readonly update = new MockUpdater(
    (v) => this.events.publish({ source: EventSource.UPDATE, event: { event: { case: "update", value: v } } }),
    () => [...this.sessions.values()].filter((s) => s.state !== SessionState.DISCONNECTED).length,
  );
  /** Phase 3a GitHub dashboards/activity and worktree details (mock/github.ts). */
  readonly gh = new GhWorld(
    (e) => this.events.publish(ghEvent(e)),
    (e) => this.repoEvents.publish(e),
  );
  /** EventService watchers that include UI intents (they count toward Emit's `delivered`). */
  uiEventWatchers = 0;
  /** SessionService.StageAttachment uploads, by returned path. */
  attachments = new Map<string, { name: string; mimeType: string; size: number }>();
  /** How long session.new takes to create a worktree (ms). */
  worktreeDelayMs = 700;
  /** Bumped by reset(), so a session.new still sleeping from before a reset does nothing. */
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
    this.threads.reset();
    this.worktreeDelayMs = 700;
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
    this.sessions.clear();
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    this.addSession({ id: "s-1", repoId: "repo-cf", worktreePath: CF, name: "Refactor sidebar tree", model: "opus", effort: "high", status: SessionStatus.BUSY, statusReason: "working: Refactor sidebar tree", createdAt: ago(42), usage: sampleUsage() });
    this.addSession({ id: "s-2", repoId: "repo-gp", worktreePath: GP, name: "Port renderer", model: "sonnet", effort: "", status: SessionStatus.NEEDS_ATTENTION, statusReason: `permission: Bash ${SEEDS["s-2"]?.reply ?? ""}`, statusChangedAt: ago(3), createdAt: ago(40) });
    this.addSession({ id: "s-3", repoId: "repo-cf", worktreePath: `${CFW}/fix-resize`, name: "Fix resize race", model: "opus", effort: "medium", state: SessionState.DISCONNECTED, disconnectReason: "exited", createdAt: ago(300), lastActivityAt: ago(95), usage: pageUsage("s-3") });
    this.addSession({ id: "s-4", repoId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Investigate flaky e2e", model: "haiku", effort: "", state: SessionState.DISCONNECTED, disconnectReason: "crashed", exitCode: 139, createdAt: ago(200), lastActivityAt: ago(17), usage: pageUsage("s-4") });
    this.addSession({ id: "s-5", repoId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Write session docs", model: "opus", effort: "low", state: SessionState.STARTING, settleIn: 8, createdAt: ago(0) });
    this.addSession({ id: "s-6", repoId: "repo-dot", worktreePath: `${HOME}/dotfiles`, name: "Tidy zshrc", model: "sonnet", effort: "", state: SessionState.CLOSING, settleIn: 8, createdAt: ago(60) });
    for (const [id, h] of Object.entries(SEEDS)) if (h) this.threads.seed(id, h);
    // Republish so connected watchers converge on the reset state.
    for (const t of this.terms.values()) this.termEvents.publish({ event: { case: "updated", value: this.terminalMsg(t) } });
    for (const r of this.repos.values()) this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(r) } });
    this.workspaceEvents.publish(this.workspaceSnapshot());
    this.sessionEvents.publish(this.sessionSnapshot());
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

  /** Why the daemon's cleanupHold keeps a worktree: a live thread, a running terminal, a workspace; "" for nothing. */
  private cleanupHold(path: string): string {
    const thread = this.threadsIn([path])[0];
    if (thread) return `live thread ${thread.name || thread.id} runs in it`;
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
    this.sessions.clear();
    this.workspaces.clear();
    for (const id of [...this.repos.keys()]) this.repoEvents.publish({ event: { case: "repoRemovedId", value: id } });
    this.repos.clear();
    this.workspaceEvents.publish(this.workspaceSnapshot());
    this.sessionEvents.publish(this.sessionSnapshot());
  }

  /** Test control: `count` connected project threads with `status` in `repo`'s main worktree. POST /__mock/threads. */
  addThreads(repo: string, count: number, status: SessionStatus, prefix: string): MockSession[] {
    const r = this.repoRef(repo);
    const path = r.worktrees.find((w) => w.isMain)?.path ?? r.path;
    const out: MockSession[] = [];
    for (let i = 1; i <= count; i++) {
      const s = this.addSession({ id: `s-t-${String(this.nextId++)}`, repoId: r.id, worktreePath: path, name: `${prefix} ${String(i)}`, model: "haiku", effort: "", status, createdAt: new Date() });
      this.publishSession(s);
      out.push(s);
    }
    return out;
  }

  /**
   * Scenario: one thread per status kind the sidebar distinguishes (lib/session statusKind),
   * with captured reasons and staggered statusChangedAt. POST /__mock/status-kinds, or
   * MOCK_SCENARIO=status-kinds. Idempotent. Not in the default world, whose rows e2e pins.
   */
  addStatusKinds(): string[] {
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const A = SessionStatus.NEEDS_ATTENTION;
    const D = SessionState.DISCONNECTED;
    type Kind = Partial<MockSession> & Pick<MockSession, "id" | "name" | "status" | "statusReason"> & { min: number };
    const kinds: Kind[] = [
      { id: "s-k-approval", name: "Run the migration script", status: A, statusReason: "waiting for approval: Bash", min: 2 },
      { id: "s-k-question", name: "Pick a color palette", status: A, statusReason: "question: Which color do you prefer?", min: 6 },
      { id: "s-k-plan", name: "Plan the settings page", status: A, statusReason: "plan: Claude has written up a plan and is ready to execute. Would you like to proceed?", min: 1 },
      { id: "s-k-finished", name: "Summarize the changelog", status: A, statusReason: "finished", min: 12 },
      { id: "s-k-error", name: "Try the new model", status: A, statusReason: "error: model_not_found", min: 20 },
      { id: "s-k-busy", name: "Index the docs", status: SessionStatus.BUSY, statusReason: "running Bash", min: 0.5 },
      { id: "s-k-idle", name: "Review lint rules", status: SessionStatus.IDLE, statusReason: "at prompt", min: 50 },
      { id: "s-k-interrupted", name: "Migrate the config loader", status: SessionStatus.ERROR, statusReason: "interrupted", min: 35, state: D, disconnectReason: "daemon stopped" },
      { id: "s-k-asked-before-restart", name: "Choose sidebar density", status: A, statusReason: "question: Which density should the sidebar use?", min: 90, state: D, disconnectReason: "daemon restarted" },
    ];
    const out: string[] = [];
    for (const { min, ...k } of kinds) {
      out.push(k.id);
      if (this.sessions.has(k.id)) continue;
      const s = this.addSession({ repoId: "repo-cf", worktreePath: CF, model: "haiku", effort: "medium", createdAt: ago(min + 5), lastActivityAt: ago(min), statusChangedAt: ago(min), ...k });
      this.publishSession(s);
    }
    return out;
  }

  /** Test control: a connected thread owned by the workspace, running in `repo`'s member (else the first). */
  addWorkspaceThread(workspace: string, repo: string, name: string, status: SessionStatus = SessionStatus.IDLE): MockSession {
    const ws = this.workspaceRef(workspace);
    const member = repo ? ws.members.find((m) => m.repoId === this.repoRef(repo).id) : ws.members[0];
    if (!member) throw new CommandError("unavailable", `repo ${repo} is not a member of workspace ${ws.name}`);
    const s = this.addSession({ id: `s-ws-${String(this.nextId++)}`, repoId: member.repoId, worktreePath: member.worktreePath, name, model: "haiku", effort: "", workspaceId: ws.id, status, createdAt: new Date() });
    this.publishSession(s);
    return s;
  }

  /**
   * session.run-in: a disconnected thread moves at once; a live one gets the target as
   * pendingWorktreePath and moves ~2s after it stops being busy (MockSession.moveIn).
   * Asking for the current member cancels a queued move.
   */
  runIn(s: MockSession, repoRef: string, worktree: string): MockSession {
    if (!s.workspaceId) throw new CommandError("unavailable", `thread ${s.id} does not belong to a workspace`);
    const ws = this.workspaceRef(s.workspaceId);
    const member = worktree ? ws.members.find((m) => m.worktreePath === worktree) : ws.members.find((m) => m.repoId === this.repoRef(repoRef).id);
    if (!member) throw new CommandError("unavailable", `${repoRef || worktree} is not a member of workspace ${ws.name}`);
    if (s.state === SessionState.CLOSING) throw new CommandError("unavailable", `thread ${s.id} is closing`);
    if (s.state === SessionState.DISCONNECTED || member.worktreePath === s.worktreePath) {
      s.pendingWorktreePath = "";
      if (member.worktreePath !== s.worktreePath) {
        s.worktreePath = member.worktreePath;
        s.repoId = member.repoId;
      }
    } else {
      s.pendingWorktreePath = member.worktreePath;
      s.moveIn = 2;
    }
    this.publishSession(s);
    return s;
  }

  private applyMove(s: MockSession): void {
    const path = s.pendingWorktreePath;
    const ws = this.workspaces.get(s.workspaceId);
    const member = ws?.members.find((m) => m.worktreePath === path);
    s.pendingWorktreePath = "";
    if (member) {
      s.worktreePath = member.worktreePath;
      s.repoId = member.repoId;
    }
    this.publishSession(s);
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
  private threadsIn(paths: readonly string[]): MockSession[] {
    return [...this.sessions.values()].filter((s) => s.state !== SessionState.DISCONNECTED && paths.some((p) => s.worktreePath === p || s.worktreePath.startsWith(`${p}/`)));
  }

  private dropWorktree(path: string): void {
    for (const repo of this.repos.values()) {
      if (!repo.worktrees.some((w) => w.path === path)) continue;
      repo.worktrees = repo.worktrees.filter((w) => w.path !== path);
      this.repoEvents.publish({ event: { case: "worktreeRemoved", value: { repoId: repo.id, path } } });
    }
    this.closeShells((l) => l[LABEL_WORKTREE] === path);
  }

  /** workspace.remove-repo: refused while a live thread runs there or with changes (unless force). */
  removeWorkspaceRepo(workspace: string, repoRef: string, force: boolean): MockWorkspace {
    const ws = this.workspaceRef(workspace);
    const member = ws.members.find((m) => m.worktreePath === repoRef) ?? ws.members.find((m) => m.repoId === this.repoRef(repoRef).id);
    if (!member) throw new CommandError("unavailable", `${repoRef} is not a member of workspace ${ws.name}`);
    const busy = this.threadsIn([member.worktreePath])[0];
    if (busy) throw new CommandError("unavailable", `thread ${busy.name || busy.id} (${busy.id}) running in ${member.worktreePath}; close it first`);
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
    if (busy) throw new CommandError("unavailable", `thread ${busy.name || busy.id} (${busy.id}) running in ${busy.worktreePath}; close it first`);
    const paths = new Set(ws.members.map((m) => m.worktreePath));
    const dirty = [...this.repos.values()].flatMap((r) => r.worktrees).find((w) => paths.has(w.path) && w.status.dirty);
    if (dirty && !force) throw new CommandError("unavailable", `worktree ${dirty.path} has uncommitted changes; use --force`);
    for (const m of ws.members) this.dropWorktree(m.worktreePath);
    this.workspaces.delete(ws.id);
    this.workspaceEvents.publish({ event: { case: "removedId", value: ws.id } });
  }

  // ---- Sessions -----------------------------------------------------------------

  private addSession(o: Partial<MockSession> & Pick<MockSession, "id" | "repoId" | "worktreePath" | "name" | "model" | "effort">): MockSession {
    const state = o.state ?? SessionState.CONNECTED;
    const status = o.status ?? SessionStatus.IDLE;
    const s: MockSession = {
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
      effortPending: false,
      firstMessage: null,
      linkedPullRequests: [],
      usage: [],
      contextTokens: 0,
      contextModel: "",
      lastResultAt: null,
      moveIn: 0,
      settleIn: 0,
      nameIn: 0,
      pendingName: "",
      held: false,
      ...o,
      state,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  sessionMsg(s: MockSession): SessionInit {
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
      effortPending: s.effortPending,
      linkedPullRequests: s.linkedPullRequests.map((l) => ({ slug: l.slug, number: l.number, url: l.url, linkedAt: timestampFromDate(l.linkedAt) })),
      ...usageFields(s.usage),
      ...contextFields(s, this.cacheTTLSeconds()),
    };
  }

  sessionSnapshot(): SessionEventInit {
    return { event: { case: "snapshot", value: { sessions: [...this.sessions.values()].map((s) => this.sessionMsg(s)), retiredUsage: retiredUsage() } } };
  }

  session(id: string): MockSession {
    const s = this.sessions.get(id);
    if (!s) throw new CommandError("notfound", `session ${id} not found`);
    return s;
  }

  private publishSession(s: MockSession): void {
    this.sessionEvents.publish({ event: { case: "updated", value: this.sessionMsg(s) } });
  }

  /**
   * Session → disconnected (its claude process is gone). Like the daemon, the status it had
   * is kept, except busy, which becomes ERROR "interrupted".
   * `status`, when given, is the status it had at that moment (tests use it: s-1 flips
   * busy/idle on a timer).
   */
  disconnectSession(id: string, reason: string, code: number, status?: SessionStatus): void {
    const s = this.session(id);
    if (status !== undefined) this.setStatus(s, status);
    if (s.status === SessionStatus.BUSY) this.setStatus(s, SessionStatus.ERROR, "interrupted");
    s.state = SessionState.DISCONNECTED;
    s.disconnectReason = reason;
    s.exitCode = code;
    s.settleIn = 0;
    s.lastActivityAt = new Date();
    this.publishSession(s);
  }

  /**
   * Claude linked a pull request to the session (a pr-link transcript record): appended
   * unless its URL is already linked, like the daemon. agoMs backdates linkedAt (the
   * record's timestamp). Returns whether it was new.
   */
  linkPullRequest(id: string, slug: string, number: number, agoMs = 0): boolean {
    const s = this.session(id);
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug) || !Number.isInteger(number) || number <= 0) throw new CommandError("invalid", "slug must be owner/name and number a positive integer");
    if (!Number.isFinite(agoMs) || agoMs < 0) throw new CommandError("invalid", "ago must be a non-negative number of milliseconds");
    const url = `https://github.com/${slug}/pull/${String(number)}`;
    if (s.linkedPullRequests.some((l) => l.url === url)) return false;
    s.linkedPullRequests = [...s.linkedPullRequests, { slug, number, url, linkedAt: new Date(Date.now() - agoMs) }];
    this.publishSession(s);
    return true;
  }

  /**
   * Claude made requests: adds counters to the session's (model, day) bucket, or a new
   * bucket, and republishes the session (the daemon's live fold, coarser).
   */
  addUsage(id: string, u: MockUsage): void {
    const s = this.session(id);
    if (!u.model) throw new CommandError("invalid", "model is required");
    const counters = [u.requests, u.input, u.output, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h];
    if (counters.some((n) => !Number.isInteger(n) || n < 0)) throw new CommandError("invalid", "counters must be non-negative integers");
    const i = s.usage.findIndex((b) => b.model === u.model && b.day === u.day && (b.tier ?? "") === (u.tier ?? "") && (b.speed ?? "") === (u.speed ?? ""));
    const old = s.usage[i];
    const merged: MockUsage = old
      ? { ...old, requests: old.requests + u.requests, input: old.input + u.input, output: old.output + u.output, cacheRead: old.cacheRead + u.cacheRead, cacheWrite5m: old.cacheWrite5m + u.cacheWrite5m, cacheWrite1h: old.cacheWrite1h + u.cacheWrite1h }
      : u;
    s.usage = old ? s.usage.map((b, j) => (j === i ? merged : b)) : [...s.usage, merged];
    this.publishSession(s);
  }

  /** The detector's reading changed (reason defaults to a typical one for the status). */
  /** Test control: the clock stops (or, held false, resumes) changing this thread (MockSession.held); controls and input always do. */
  holdSession(id: string, held = true): void {
    this.session(id).held = held;
  }

  setSessionStatus(id: string, status: SessionStatus, reason?: string): void {
    const s = this.session(id);
    if (s.state === SessionState.DISCONNECTED) throw new CommandError("unavailable", "session is disconnected");
    if (status === SessionStatus.ERROR) throw new CommandError("invalid", "error is set only by a disconnect while busy");
    this.setStatus(s, status, reason);
    s.lastActivityAt = new Date();
    this.publishSession(s);
  }

  /** Sets status and reason, stamping statusChangedAt when either changes (Session.setStatus). */
  private setStatus(s: MockSession, status: SessionStatus, reason: string = defaultReason(status)): void {
    if (s.status === status && s.statusReason === reason) return;
    s.status = status;
    s.statusReason = reason;
    s.statusChangedAt = new Date();
  }

  /**
   * The sketch's scripted thread (mock/thread.ts) in a state: "Fix stale PR badge" in
   * code-foundry, connected, accept-edits. Replaces it when it exists.
   */
  addScriptedThread(state: ThreadState, id = "s-r1"): MockSession {
    if (this.sessions.has(id)) {
      this.sessions.delete(id);
      this.sessionEvents.publish({ event: { case: "removedId", value: id } });
    }
    const s = this.addSession({
      id,
      repoId: "repo-cf",
      worktreePath: CF,
      name: "Fix stale PR badge",
      model: "opus",
      effort: "high",
      permissionMode: PermissionMode.ACCEPT_EDITS,
      createdAt: new Date(Date.now() - 10 * 60_000),
      // The earlier turn's result, two minutes ago: the cache is warm.
      contextTokens: 25_700,
      contextModel: "claude-opus-4-8",
      lastResultAt: new Date(Date.now() - 2 * 60_000),
    });
    this.threads.load(id, state);
    if (state === "closed") this.disconnectSession(id, "closed", 0);
    if (state === "crashed") {
      // Before the handshake: no turn ran, so no status to keep.
      s.lastError = CRASH_STDERR;
      this.disconnectSession(id, "crashed", 1, SessionStatus.UNSPECIFIED);
    }
    this.publishSession(s);
    return s;
  }

  /** sessions.cache_ttl_seconds (the daemon's default when unset). */
  private cacheTTLSeconds(): number {
    return Number(this.settings.values()["sessions.cache_ttl_seconds"] || 3600);
  }

  /** POST /__mock/thread/cache: the thread's last result `agoSeconds` ago (optionally with `tokens`, answered by `model`). */
  ageThreadCache(id: string, agoSeconds: number, tokens?: number, model?: string): void {
    const s = this.session(id);
    s.lastResultAt = new Date(Date.now() - agoSeconds * 1000);
    if (tokens !== undefined) s.contextTokens = tokens;
    if (model !== undefined) s.contextModel = model;
    this.publishSession(s);
  }

  /** Emits FocusSession for an existing session. */
  focusSession(id: string): number {
    this.session(id);
    return this.emit({ intent: { case: "focusSession", value: { sessionId: id } } });
  }

  /** UiService.Emit: delivered to UiService watchers and EventService watchers with UI. */
  emit(intent: UiIntentInit): number {
    return this.intents.publish(intent) + this.uiEventWatchers;
  }

  /**
   * A new session in STARTING. Unnamed for ~1s, then named `pendingName` (the daemon
   * names it in the background), connected after ~2s.
   */
  private createSession(repoId: string, path: string, model: string, effort: string, extra: Partial<MockSession> = {}): MockSession {
    const id = `s-new-${String(this.nextId++)}`;
    const s = this.addSession({ id, repoId, worktreePath: path, name: "", model, effort, state: SessionState.STARTING, settleIn: 2, nameIn: 1, pendingName: `thread-${id}`, createdAt: new Date(), ...extra });
    this.publishSession(s);
    return s;
  }

  /** session.reconnect: claude --resume in a new process; STARTING until the handshake (~2 s). */
  private reconnect(s: MockSession): void {
    s.state = SessionState.STARTING;
    // The fresh detector owns status again: the persisted one is cleared.
    this.setStatus(s, SessionStatus.UNSPECIFIED);
    s.settleIn = 2;
    s.disconnectReason = "";
    s.exitCode = 0;
    s.lastError = "";
    s.lastActivityAt = new Date();
    this.publishSession(s);
  }

  private tickSessions(): void {
    for (const s of this.sessions.values()) {
      if (s.held) continue;
      // A queued run-in: the daemon sends set_cwd once the thread is idle.
      if (s.pendingWorktreePath && s.status !== SessionStatus.BUSY && --s.moveIn <= 0) this.applyMove(s);
      if (s.nameIn > 0 && --s.nameIn === 0 && !s.name) {
        s.name = s.pendingName;
        this.publishSession(s);
      }
      if (s.settleIn > 0 && --s.settleIn === 0) {
        if (s.state === SessionState.STARTING) {
          s.state = SessionState.CONNECTED;
          this.setStatus(s, SessionStatus.IDLE);
          this.publishSession(s);
          // A new thread: its first message goes out once Claude answered the handshake.
          const first = s.firstMessage;
          s.firstMessage = null;
          if (first) this.threads.send(s.id, first.text, first.attachments, first.composerText);
        } else if (s.state === SessionState.CLOSING) {
          this.disconnectSession(s.id, "closed", 0);
        }
        continue;
      }
      // s-1 alternates busy/idle every 4s; attention sticks until input arrives.
      if (s.id === "s-1" && s.state === SessionState.CONNECTED && s.status !== SessionStatus.NEEDS_ATTENTION && this.seconds % 4 === 0) {
        this.setStatus(s, s.status === SessionStatus.BUSY ? SessionStatus.IDLE : SessionStatus.BUSY);
        s.lastActivityAt = new Date();
        this.publishSession(s);
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
    this.tickSessions();
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
    // Like the daemon's shell reaper: a shell terminal.new started is removed once it exits.
    if (t.labels[LABEL_KIND] === KIND_SHELL && !keep) this.remove(id);
  }

  /** terminal.close / TerminalService.Close: kill, then remove once exited. Only shells, like the daemon. */
  close(id: string): void {
    const t = this.term(id);
    if (t.labels[LABEL_KIND] !== KIND_SHELL) throw new CommandError("unavailable", `terminal ${id} is not a shell`);
    this.kill(id);
    if (this.terms.get(id)?.state === TerminalState.EXITED) this.remove(id);
  }

  /** Closes every running or exited shell terminal.new started whose labels match (thread or worktree removal). */
  private closeShells(match: (labels: Record<string, string>) => boolean): void {
    for (const t of [...this.terms.values()]) {
      if (t.labels[LABEL_KIND] === KIND_SHELL && match(t.labels) && this.terms.has(t.id)) this.close(t.id);
    }
  }

  /**
   * Who owns a shell terminal.new starts, like the daemon (internal/command/commands_terminal.go):
   * the active thread, else the active registered worktree, else the deepest registered worktree
   * containing cwd. Refuses a cwd outside every project.
   */
  private shellOwner(ctx: UiContext | undefined, cwd: string): { labels: Record<string, string>; cwd: string } {
    const s = ctx?.activeSessionId ? this.sessions.get(ctx.activeSessionId) : undefined;
    if (ctx?.activeSessionId) {
      if (!s) throw new CommandError("notfound", `session ${ctx.activeSessionId} not found`);
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

  remove(id: string): void {
    const t = this.term(id);
    if (t.state === TerminalState.RUNNING) throw new CommandError("unavailable", "terminal is still running");
    this.terms.delete(id);
    t.attach.publish("end");
    this.termEvents.publish({ event: { case: "removedId", value: id } });
  }

  /**
   * session.new like the daemon: an explicit worktree, or (new-worktree) a cf/<slug>
   * worktree made from `base` first, which takes a moment. A prompt containing FAIL
   * fails the way a git error would, before any session exists.
   */
  private async newSession(ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> {
    if (args.workspace || args.repos) return this.newWorkspaceSession(args);
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
      if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while session.new ran");
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
    const model = args.model || "opus";
    const s = this.createSession(repo.id, path, model, args.effort ?? "", {
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
    this.focusSession(s.id);
    return { message: `created session ${s.id} in ${path}`, resultJson: JSON.stringify({ id: s.id, worktreePath: path }) };
  }

  /**
   * session.new with `workspace` (a thread owned by it, in the member `worktree` or
   * `repo` names, else the first) or `repos` with new-worktree (a new workspace named
   * from the prompt with cf/<slug> in every repo, the thread in `repo`'s member).
   */
  private async newWorkspaceSession(args: Record<string, string>): Promise<InvokeOut> {
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
      if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while session.new ran");
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
    const s = this.createSession(member.repoId, member.worktreePath, args.model || "opus", args.effort ?? "", {
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
    this.focusSession(s.id);
    return { message: `created thread ${s.id} in ${member.worktreePath} (workspace ${ws.id})`, resultJson: JSON.stringify({ id: s.id, worktreePath: member.worktreePath, workspaceId: ws.id }) };
  }

  /** SessionService.StageAttachment: keeps the bytes' size, returns a fake path. */
  stageAttachment(name: string, mimeType: string, size: number): string {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) throw new CommandError("invalid", `unsupported attachment type ${mimeType}`);
    if (size > 10 * 1024 * 1024) throw new CommandError("invalid", "attachment larger than 10 MiB");
    const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? "").toLowerCase();
    const path = `${HOME}/.code-foundry/attachments/att-${String(this.attachments.size + 1)}${ext}`;
    this.attachments.set(path, { name, mimeType, size });
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
   * pr.ask, pr.explain and pr.fix.findings (internal/command/commands_prsession.go): start a
   * session about a pull request and focus it. The worktree rules follow the daemon's
   * pickPRWorktree; the prompt is not built here (the mock's sessions never read it).
   */
  private prSessionCommands(): ReturnType<World["registry"]> {
    const slugArg = { name: "repo-slug", type: ArgType.STRING, required: true, description: 'GitHub repository, "owner/name"' };
    const numberArg = { name: "number", type: ArgType.INT, required: true, description: "Pull request number" };
    const worktreeArg = { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree to start the session in (default: picked from the registered clones of repo-slug and the pull request's branch)" };
    const modelArg = { name: "model", type: ArgType.ENUM, required: false, description: "Model (default: settings sessions.default_model, else Claude's default)", enumValues: MODEL_VALUES };
    const effortArg = { name: "effort", type: ArgType.ENUM, required: false, description: "Effort level (default: settings sessions.default_effort, else Claude's default)", enumValues: ["low", "medium", "high", "xhigh", "max"] };
    const start =
      (fix: boolean) =>
      async (ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> => {
        // POST /__mock/gh/pr-delay?ms=800: these commands take that long (fetch, worktree, start).
        if (this.gh.prDetails.sessionDelayMs > 0) await new Promise((r) => setTimeout(r, this.gh.prDetails.sessionDelayMs));
        const slug = args["repo-slug"] ?? "";
        const n = Number(args.number);
        if (!slug.trim()) throw new CommandError("invalid", "repo-slug is required");
        if (!Number.isInteger(n) || n <= 0) throw new CommandError("invalid", "number must be a positive pull request number");
        // POST /__mock/gh/pr-fail?command=pr.fix.findings (or pr.ask, pr.explain): the next run fails.
        // Codes as the daemon's (internal/command/commands_prsession.go): the fork is a
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
        const defaults = this.sessionDefaults();
        const s = this.createSession(target.repoId, target.path, args.model ?? defaults.model, args.effort ?? defaults.effort);
        this.focusSession(s.id);
        // Like the daemon: the result JSON is the created Session (protojson).
        return {
          message: `Started session ${s.id} for PR #${String(n)}`,
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
          description: "Start a Claude session that answers a question about a pull request without changing code.",
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
          description: "Start a Claude session that walks through a pull request for a first-time reviewer.",
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
          description: "Start a Claude session on the pull request's branch that fixes its unresolved review comments and failing checks.",
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
    const activeSession = (ctx: UiContext | undefined) => (ctx?.activeSessionId ? this.sessions.get(ctx.activeSessionId) : undefined);
    const always = () => true;
    return [
      ...viewCommands((i) => this.emit(i)),
      ...this.threads.commands(),
      ...mcpCommands(this.threads, (i) => this.emit(i)),
      {
        cmd: { name: "terminal.new", title: "New Terminal", category: "Terminal", description: "Start a shell that belongs to the active thread, else to the active worktree", keybindings: ["cmd+t"], args: [{ name: "cwd", type: ArgType.PATH, required: false, description: "Working directory" }] },
        // Like the daemon: a thread, or a worktree to own the shell (never the dashboard or a page).
        when: (ctx) => Boolean(ctx?.activeSessionId || ctx?.activeWorktreePath),
        // Like the daemon: no focus intent; the result's JSON is the new terminal (the GUI
        // focuses it in the bottom panel by its id).
        run: (ctx, args) => {
          const owner = this.shellOwner(ctx, args.cwd ?? "");
          const t = this.create(["/bin/zsh"], owner.cwd, owner.labels, "shell");
          return Promise.resolve({ message: `created terminal ${t.id}`, resultJson: JSON.stringify({ id: t.id, cwd: t.cwd, labels: t.labels }) });
        },
      },
      {
        cmd: {
          name: "session.new",
          title: "New Thread",
          category: "Session",
          description: "Start Claude Code in a worktree (or a new one), with a first prompt",
          keybindings: ["cmd+n"],
          args: [
            { name: "repo", type: ArgType.STRING, required: false, description: "Repository id" },
            { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree path" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name the thread belongs to" },
            { name: "repos", type: ArgType.STRING, required: false, description: "With new-worktree: repositories for a new workspace (repo[:base], comma-separated)" },
            { name: "model", type: ArgType.ENUM, required: false, description: "Model", enumValues: MODEL_VALUES, defaultValue: "opus" },
            { name: "effort", type: ArgType.ENUM, required: false, description: "Effort", enumValues: ["low", "medium", "high", "xhigh", "max"], defaultValue: "high" },
            { name: "permission", type: ArgType.ENUM, required: false, description: "Permission mode", enumValues: ["supervised", "accept-edits", "auto"] },
            { name: "new-worktree", type: ArgType.BOOL, required: false, description: "Create a worktree for the thread" },
            { name: "base", type: ArgType.STRING, required: false, description: "Base ref for the new worktree" },
            { name: "name", type: ArgType.STRING, required: false, description: "Thread name" },
            { name: "prompt", type: ArgType.STRING, required: false, description: "First prompt" },
            { name: "attachments", type: ArgType.STRING, required: false, description: "Staged attachment paths, comma-separated" },
            { name: "composer-prompt", type: ArgType.STRING, required: false, description: "The composer's text of prompt with its tag tokens" },
          ],
        },
        when: (ctx) => this.worktreeOf(ctx) !== null || Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)),
        run: (ctx, args) => this.newSession(ctx, args),
      },
      {
        cmd: { name: "session.close", title: "Close Thread", category: "Session", description: "Exit Claude gracefully; the session stays, disconnected", keybindings: ["cmd+shift+w"], args: [] },
        when: (ctx) => activeSession(ctx)?.state === SessionState.CONNECTED,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          s.state = SessionState.CLOSING;
          s.settleIn = 2;
          this.publishSession(s);
          return "";
        },
      },
      {
        cmd: { name: "session.fork", title: "Fork Thread", category: "Session", description: "Start a new session that continues this one's conversation", keybindings: [], args: [{ name: "name", type: ArgType.STRING, required: false, description: "Name for the fork" }] },
        when: (ctx) => activeSession(ctx) !== undefined,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          const f = this.createSession(s.repoId, s.worktreePath, s.model, s.effort, { pendingName: `${s.name || s.id} (fork)`, permissionMode: s.permissionMode, parentId: s.id });
          this.threads.fork(s.id, f.id, s.name || s.id);
          this.focusSession(f.id);
          return `Forked ${s.name || s.id}`;
        },
      },
      {
        cmd: { name: "session.reconnect", title: "Reconnect Thread", category: "Session", description: "Resume the session in a new claude process (claude --resume)", keybindings: ["cmd+shift+r"], args: [] },
        when: (ctx) => activeSession(ctx)?.state === SessionState.DISCONNECTED,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          this.reconnect(s);
          return "";
        },
      },
      {
        cmd: { name: "session.rename", title: "Rename Thread", category: "Session", description: "Set the session's name", keybindings: ["cmd+r"], args: [{ name: "name", type: ArgType.STRING, required: true, description: "New name" }] },
        when: (ctx) => activeSession(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          s.name = args.name ?? s.name;
          s.autoNamed = false;
          this.publishSession(s);
          return "";
        },
      },
      {
        cmd: {
          name: "session.run-in",
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
        when: (ctx) => activeSession(ctx) !== undefined && Boolean(ctx?.activeWorkspaceId || !ctx?.activeView),
        run: (ctx, args) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          if (!args.repo && !args.worktree) throw new CommandError("invalid", "name the member: a repository or a worktree path");
          const out = this.runIn(s, args.repo ?? "", args.worktree ?? "");
          const label = out.name ? `${out.name} (${out.id})` : out.id;
          return out.pendingWorktreePath ? `thread ${label} moves to ${out.pendingWorktreePath} once it is idle` : `thread ${label} runs in ${out.worktreePath}`;
        },
      },
      {
        cmd: {
          name: "session.pin",
          title: "Pin or Unpin Thread",
          category: "Thread",
          description: "Pin a thread to the top of the thread list, or unpin it. Without pinned, toggles the current pin.",
          keybindings: [],
          args: [{ name: "pinned", type: ArgType.BOOL, required: false, description: "Pin (true) or unpin (false)" }],
        },
        when: (ctx) => activeSession(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          s.pinned = args.pinned === undefined || args.pinned === "" ? !s.pinned : args.pinned === "true";
          this.publishSession(s);
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
          name: "session.remove", title: "Remove Thread", category: "Session", description: "Forget the session (closes it first if connected)", keybindings: [], args: [],
          confirm: (ctx) => `Remove session ${ctx?.activeSessionId ?? ""}? It is closed first if connected, and its row is forgotten.`,
        },
        when: (ctx) => activeSession(ctx) !== undefined,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          if (s.state !== SessionState.DISCONNECTED) this.disconnectSession(s.id, "closed", 0);
          this.closeShells((l) => l[LABEL_SESSION] === s.id);
          this.sessions.delete(s.id);
          this.sessionEvents.publish({ event: { case: "removedId", value: s.id } });
          return `Removed ${s.name || s.id}`;
        },
      },
      {
        cmd: {
          name: "terminal.kill", title: "Kill Terminal", category: "Terminal", description: "Send SIGHUP to the active terminal", keybindings: ["cmd+alt+w"], args: [],
          confirm: (ctx) => `Kill terminal ${ctx?.activeTerminalId ?? ""}? Its process is terminated.`,
        },
        when: (ctx) => activeTerm(ctx)?.state === TerminalState.RUNNING,
        run: (ctx) => {
          const t = activeTerm(ctx);
          if (!t) throw new CommandError("unavailable", "no active terminal");
          this.kill(t.id);
          return `Killed ${t.id}`;
        },
      },
      {
        // --id defaults to the active terminal, like the daemon (a context-bound arg, so not required in List).
        cmd: { name: "terminal.close", title: "Close Terminal", category: "Terminal", description: "Terminate the terminal's process and remove it once it has exited", keybindings: [], args: [{ name: "id", type: ArgType.STRING, required: false, description: "Terminal id (default: the active terminal)" }] },
        // Only shells, like the daemon.
        when: (ctx) => activeTerm(ctx)?.labels[LABEL_KIND] === KIND_SHELL,
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
      ...this.prSessionCommands(),
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
        cmd: { name: "view.bottom.toggle", title: "Toggle Bottom Panel", category: "View", description: "Show or hide the terminals under the selected thread or page.", keybindings: ["cmd+j"], args: [] },
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
        when: (ctx) => Boolean(ctx?.activeSessionId && ctx.activeWorkspaceId),
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
        when: (ctx) => Boolean(ctx?.activeSessionId && ctx.activeRepoId && ctx.activeWorktreePath),
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
        when: (ctx) => Boolean(ctx?.activeSessionId),
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
        when: (ctx) => Boolean(ctx?.activeSessionId),
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
      ...this.update.commands(),
    ];
  }

  /** The registry with settings applied: keybinding overrides and session.new defaults. */
  /** sessions.default_model and sessions.default_effort ("" when unset). */
  private sessionDefaults(): { model: string; effort: string } {
    const v = this.settings.values();
    return { model: v["sessions.default_model"] ?? "", effort: v["sessions.default_effort"] ?? "" };
  }

  /**
   * The registry with settings applied: keybinding overrides, and the session defaults on
   * every command that starts a session (internal/daemon/settings.go registryOverrides).
   */
  private effectiveRegistry(): ReturnType<World["registry"]> {
    const entries = this.registry();
    const kb = this.settings.keybindings();
    const defaults: Record<string, string> = this.sessionDefaults();
    const startsSession = new Set(["session.new", "pr.ask", "pr.explain", "pr.fix.findings"]);
    return entries.map((e) => ({
      ...e,
      cmd: {
        ...e.cmd,
        keybindings: kb[e.cmd.name] ?? e.cmd.keybindings,
        args: e.cmd.args.map((a) => {
          const d = startsSession.has(e.cmd.name) && (a.name === "model" || a.name === "effort") ? defaults[a.name] : "";
          return d && a.enumValues?.includes(d) ? { ...a, defaultValue: d } : a;
        }),
      },
    }));
  }

  listCommands(ctx: UiContext | undefined, includeUnavailable: boolean): (Omit<CmdDef, "confirm"> & { available: boolean; requiresConfirmation: boolean })[] {
    return this.effectiveRegistry()
      .map(({ cmd: { confirm, ...cmd }, when }) => ({ ...cmd, available: when(ctx), requiresConfirmation: confirm !== undefined }))
      .filter((c) => includeUnavailable || c.available);
  }

  invoke(name: string, ctx: UiContext | undefined, args: Record<string, string>, confirmed = false): string | Promise<InvokeOut> {
    const entry = this.effectiveRegistry().find((e) => e.cmd.name === name);
    this.invocations.push({
      name,
      context: ctx
        ? {
            activeTerminalId: ctx.activeTerminalId,
            activeSessionId: ctx.activeSessionId,
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
    const whenCtx = args.worktree ? ({ ...ctx, activeWorktreePath: args.worktree } as UiContext) : ctx;
    if (!entry.when(whenCtx)) throw new CommandError("unavailable", `${name} is not available here`);
    for (const a of entry.cmd.args) {
      if (a.required && !args[a.name]) throw new CommandError("invalid", `missing required arg ${a.name}`);
    }
    if (entry.cmd.confirm && !confirmed) throw new ConfirmNeeded(name, entry.cmd.title, entry.cmd.confirm(ctx, args));
    return entry.run(ctx, args);
  }
}
