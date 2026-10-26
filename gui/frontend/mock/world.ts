/**
 * In-memory fake daemon state: projects, worktrees, threads (mock/thread.ts), shells with
 * scripted output, the command registry, and intent fan-out. Deterministic initial state; reset() restores it.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { EventSource, type EventSchema } from "../src/gen/codefoundry/v1/events_pb";
import type { ProjectEventSchema, ProjectSchema, WorktreeSchema } from "../src/gen/codefoundry/v1/project_pb";
import { PermissionMode, ThreadFlagLevel, ThreadKind, ThreadState, ThreadStatus, type ThreadListEventSchema, type ThreadSchema } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { TerminalState, type AttachEventSchema, type TerminalEventSchema, type TerminalSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";
import type { WorkspaceEventSchema, WorkspaceSchema } from "../src/gen/codefoundry/v1/workspace_pb";
import { MockGitOps, type GitOpsEventInit, type InvokeOut } from "./gitops";
import { prDetailCall } from "./prDetail";
import { GhWorld, ghEvent, viewCommands } from "./github";
import { bridgeCommands } from "./bridgeCommands";
import { cloneExists } from "./clone";
import { folderInfo, HOME, projectFolder } from "./filesystem";
import { projectCommands } from "./create";
import { Hub } from "./hub";
import { MockSettings, MODEL_VALUES } from "./settings";
import { MockBackdrops } from "./backdrops";
import { themesFor } from "../src/themes";
import { MockUpdater, type RestartCost } from "./update";
import { pageUsage, retiredUsage, sampleUsage, usageFields, type MockUsage } from "./usage";
import { ENTER_ALT, prompt, RESET, topFrame } from "./screens";
import { CommandError } from "./errors";
import { agentCounts, agentsCommands, listRuns } from "./agents";
import { mcpCommands } from "./mcp";
import { HELLO_TERMINAL, HELLO_THREAD, MockPlugins } from "./plugins";
import { MockActions } from "./actions";
import { MockMemory } from "./memory";
import { MockThemes } from "./userThemes";
import { MockSkills } from "./skills";
import { EMBER_THREAD, emberWorkers, MockEmber } from "./ember";
import { CRASH_STDERR, MockThreadLogs, type SeedHistory, type ThreadState as ScriptedThreadState } from "./thread";
import { contextFields, recordResult, type MockContext } from "./context";
import { panelThreadArgs, runPanelVerb } from "./panelVerbs";
import { panelItemCommands } from "./panelItemVerbs";
import { createHints, type SetThread } from "./projectSets";

type TerminalInit = MessageInitShape<typeof TerminalSchema>;
type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;
type TerminalEventInit = MessageInitShape<typeof TerminalEventSchema>;
type ProjectInit = MessageInitShape<typeof ProjectSchema>;
type WorktreeInit = MessageInitShape<typeof WorktreeSchema>;
type ProjectEventInit = MessageInitShape<typeof ProjectEventSchema>;
type ThreadInit = MessageInitShape<typeof ThreadSchema>;
type ThreadListEventInit = MessageInitShape<typeof ThreadListEventSchema>;
export type EventInit = MessageInitShape<typeof EventSchema>;
type WorkspaceInit = MessageInitShape<typeof WorkspaceSchema>;
type WorkspaceEventInit = MessageInitShape<typeof WorkspaceEventSchema>;

/**
 * A workspace (the daemon's workspace store since workspaces v2,
 * docs/notes/workspaces-v2-2-workspaces.md): a saved set of projects, an optional root and
 * where new threads start. What its managed dir holds (the instructions file's name and
 * the skills) is set by the test controls, as a thread writing them would.
 */
export interface MockWorkspace {
  id: string;
  name: string;
  /** Project ids, sorted. */
  members: string[];
  /** A rooted workspace's folder; "" for a synthetic one. */
  rootPath: string;
  /** A member project id, or "workspace". */
  defaultPrimary: string;
  /** "CLAUDE.md", "AGENTS.md" or "" (none yet). */
  instructions: string;
  /** Skill folder names in .claude/skills, sorted. */
  skills: string[];
  /** A rooted workspace's root is gone (moved or renamed). */
  rootMissing?: boolean;
  createdAt: Date;
}

/** One checkout of a thread (ThreadService.Checkouts). */
interface MockCheckout {
  projectId: string;
  projectName: string;
  path: string;
  branch: string;
  primary: boolean;
  missing: boolean;
  git: boolean;
  derived: boolean;
}

interface MockThread {
  id: string;
  claudeSessionId: string;
  projectId: string;
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
  /**
   * The thread whose agent created this one (thread.new's created-by), and its name then;
   * "" when the user made it (docs/notes/agents-2-metadata.md). POST /__mock/lineage.
   */
  createdBy: string;
  createdByName: string;
  /**
   * Thread.in_sidebar: a created thread shown (true) or hidden (false) in the sidebar
   * whatever threads.show_created_threads says; null follows the setting (thread.sidebar,
   * thread.new --sidebar; docs/notes/hidden-children-1-daemon.md).
   */
  inSidebar: boolean | null;
  /** What the thread was started for, in its creator's words; "" when none. */
  brief: string;
  labels: string[];
  permissionMode: PermissionMode;
  baseRef: string;
  createdWorktree: boolean;
  /**
   * Thread.project_ids: the project set besides projectId (the primary), as the daemon's
   * thread new --projects makes it; threadMsg sorts it with projectId and a workspace
   * thread's members (docs/notes/workspaces-v2-1-threads.md).
   */
  projectIds: string[];
  /** Thread.branch: a worktree-mode thread's branch (createdWorktree); "" in checkout mode. */
  branch: string;
  /** The workspace the thread references; "" when none. */
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
  /**
   * Plugins' flags (Thread.flags; POST /__mock/thread/flag), one per plugin, errors first then
   * newest. Archiving clears them; opening the thread clears until-seen ones.
   */
  flags: MockFlag[];
  /** "plugin:<name>" for a plugin's own thread (hidden from the user's lists); "" for the user's. */
  owner: string;
  /**
   * A resident thread's name (Thread.kind RESIDENT, resident_name; POST /__mock/resident):
   * the daemon's own agent thread, hidden from the user's lists; "" for any other.
   */
  resident: string;
  /** Thread.epoch: its session count, 1 until a reseed. */
  epoch: number;
  /**
   * Thread.plugin_env_change while plugin_env_stale (POST /__mock/thread/envstale): a plugin's
   * session environment changed since the running process started; "" when current.
   * thread.restart and the process's end clear it (docs/notes/plugins-env-restart.md).
   */
  pluginEnvChange: string;
}

/** A plugin's flag on a thread (docs/notes/plugins-3-events-flags-env.md). */
export interface MockFlag {
  plugin: string;
  pluginDisplayName: string;
  level: ThreadFlagLevel;
  reason: string;
  setAt: Date;
  untilSeen: boolean;
}

interface ArgDef {
  name: string;
  type: ArgType;
  required: boolean;
  description: string;
  enumValues?: string[];
  defaultValue?: string;
  /** Like the daemon's ArgSpec.default_to_thread_env: the CLI (and a page's bridge) sends the caller's thread. */
  defaultToThreadEnv?: boolean;
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
  /** Like the daemon's Command.ConfirmLabel: the confirm button's words. */
  confirmLabel?: string;
  /** Like the daemon's Command.read_only: it changes nothing (a page's bridge runs it without a click). */
  readOnly?: boolean;
}
export type UiIntentInit = MessageInitShape<typeof UiIntentSchema>;

/** clock: a plugin's terminal printing the date every two seconds (the hello demo's Shell tab). */
type Kind = "top" | "shell" | "action" | "clock";

// The terminal label contract (internal/termlabel, proto Terminal.labels).
const LABEL_KIND = "kind";
const LABEL_THREAD = "thread";
const LABEL_PROJECT = "project";
const LABEL_WORKTREE = "worktree";
const KIND_SHELL = "shell";
const KIND_ACTION = "action";
const KIND_SETUP = "setup";

/** termlabel.IsPanel: a shell, an action run or a skill's setup (the bottom panel's terminals; what close and thread removal take). */
const isPanel = (labels: Record<string, string>) => labels[LABEL_KIND] === KIND_SHELL || labels[LABEL_KIND] === KIND_ACTION || labels[LABEL_KIND] === KIND_SETUP;

/** Labels of a shell terminal.new starts: owned by a worktree, and by a thread when threadId is set. */
function shellLabels(threadId: string, projectId: string, worktree: string): Record<string, string> {
  const l: Record<string, string> = { [LABEL_KIND]: KIND_SHELL, [LABEL_PROJECT]: projectId, [LABEL_WORKTREE]: worktree };
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

/**
 * The daemon's hiddenWorkingText: thread.archive's clause for n hidden threads still
 * working below the thread named root.
 */
function hiddenWorkingText(n: number, root: string): string {
  if (n === 1) {
    return `1 hidden child thread is still working; archiving ends its turn and archives it too. To keep it, ask ${root} to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.`;
  }
  return `${String(n)} hidden child threads are still working; archiving ends their turns and archives them too. To keep one, ask ${root} to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.`;
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

interface MockProject {
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
   * project.git.init. Absent means git.
   */
  git?: boolean;
  worktrees: MockWorktree[];
}

/** A project without git refuses what needs git, like the daemon (FailedPrecondition). */
function requireGit(project: MockProject, what = "this"): void {
  if (project.git === false) throw new CommandError("unavailable", `${project.name} is not a git repository; ${what} needs git`);
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
    readonly confirmLabel = "",
  ) {
    super(message);
  }
}

// In its own module so mock/thread.ts can throw it without importing the world.
export { CommandError };

// Project paths under the fake home (mock/filesystem.ts lists the same tree).
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

/** Where the mock daemon makes worktrees (the daemon's project store WorktreeRoot). */
const WORKTREE_ROOT = `${HOME}/.code-foundry/worktrees`;

/** Made by the app: strictly inside its worktrees directory (the daemon's Worktree.Managed). */
function managed(w: MockWorktree): boolean {
  return w.path.startsWith(`${WORKTREE_ROOT}/`);
}

/** Why the daemon's cleanup may remove w (the only reason the mock models). */
function removedReason(w: MockWorktree): string {
  return `branch is in ${w.status.baseRef ?? "origin/main"}`;
}

/**
 * The daemon's project.CleanupVerdict removable: not main, made by the app, on a branch, nothing uncommitted, every
 * commit in baseRef. The mock tells "made by the app" by path and does not model the 10-minute grace or rebased copies.
 */
function mergedClean(w: MockWorktree): boolean {
  const st = w.status;
  return !w.isMain && managed(w) && !w.detached && w.branch !== "" && !st.dirty && st.staged + st.modified + st.untracked === 0 && Boolean(st.baseRef) && (st.baseAhead ?? 0) === 0;
}

function initialProjects(): MockProject[] {
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
      // project.git.init makes it a git repository on main with an empty first commit.
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
/** A `date` line like the clock terminal's. */
function clockLine(d: Date): string {
  return d.toString().replace(/ GMT.*$/, "");
}

const SEEDS: Readonly<Record<string, SeedHistory | undefined>> = {
  [HELLO_THREAD]: {
    prompt: "say hello in one line",
    intro: "Checking the environment the plugin gave me.",
    command: "printenv CF_HELLO_THREAD",
    output: "1",
    reply: "Hello from the hello plugin, running in its data directory.",
    minutesAgo: 2,
    end: "done",
  },
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
    exitCode: 139,
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
  projects = new Map<string, MockProject>();
  threads = new Map<string, MockThread>();
  workspaces = new Map<string, MockWorkspace>();
  /** EventService: every hub below tees into this one, so its order is publish order. */
  readonly events = new Hub<{ source: EventSource; event: EventInit }>();
  readonly termEvents = new Hub<TerminalEventInit>((v) => this.events.publish({ source: EventSource.TERMINAL, event: { event: { case: "terminal", value: v } } }));
  readonly projectEvents = new Hub<ProjectEventInit>((v) => this.events.publish({ source: EventSource.PROJECT, event: { event: { case: "project", value: v } } }));
  readonly workspaceEvents = new Hub<WorkspaceEventInit>((v) => this.events.publish({ source: EventSource.WORKSPACE, event: { event: { case: "workspace", value: v } } }));
  readonly threadListEvents = new Hub<ThreadListEventInit>((v) => this.events.publish({ source: EventSource.THREAD_LIST, event: { event: { case: "threadList", value: v } } }));
  readonly intents = new Hub<UiIntentInit>((v) => this.events.publish({ source: EventSource.UI, event: { event: { case: "ui", value: v } } }));
  readonly gitopsEvents = new Hub<GitOpsEventInit>((v) => this.events.publish({ source: EventSource.GITOPS, event: { event: { case: "gitops", value: v } } }));
  /** Threads' conversations (mock/thread.ts); the EventService thread source carries their pending requests. */
  readonly logs: MockThreadLogs = new MockThreadLogs(
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
      seenFlags: (id) => {
        this.seenFlags(id);
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
      themeCard: (id) => this.themes.cardOf(id),
      setThemeSlot: (scheme, id) => {
        this.settings.update({ [`appearance.theme_${scheme}`]: id });
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
      // And a new plugins.registries re-reads Browse (internal/daemon/plugin_registry.go).
      this.plugins.registry.settingsChanged();
      this.emberSettingsChanged();
    },
  );
  /**
   * Ember's status and task board (mock/ember.ts; EmberService). Enabled is ember.enabled;
   * turning it on adds the resident thread and the board's worker threads.
   */
  readonly ember = new MockEmber({
    enabled: () => this.settings.value("ember.enabled") === "true",
    epochContextTokens: () => Number(this.settings.value("ember.epoch_context_tokens")),
    residentId: () => (this.threads.has(EMBER_THREAD) ? EMBER_THREAD : ""),
    thread: (id) => {
      const s = this.threads.get(id);
      return s && { name: s.name, state: s.state, status: s.status, statusReason: s.statusReason, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt, archived: s.archivedAt !== null };
    },
    children: (id) =>
      [...this.threads.values()]
        .filter((t) => t.createdBy === id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .map((t) => t.id),
    createdBy: (id) => this.threads.get(id)?.createdBy ?? "",
  });
  /** The ember.* settings the board shows, as last published (emberSettingsChanged). */
  private emberSettings = "";
  /** The backdrops folder (mock/backdrops.ts); imports select through settings. */
  readonly backdrops = new MockBackdrops(this.settings);
  /** Actions and their runs (mock/actions.ts); terminal runs are kind=action terminals here. */
  readonly actions = new MockActions({
    publish: (v) => this.events.publish({ source: EventSource.ACTION, event: { event: { case: "action", value: v } } }),
    projects: () => [...this.projects.values()].map((r) => ({ id: r.id, name: r.name, worktrees: r.worktrees.map((w) => w.path) })),
    thread: (id) => {
      const s = this.threads.get(id);
      return s && { projectId: s.projectId, worktreePath: s.worktreePath };
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
  /** Plugins and the hello demo surface (mock/plugins.ts); the EventService plugin source. */
  readonly plugins = new MockPlugins({
    publish: (v) => this.events.publish({ source: EventSource.PLUGIN, event: { event: { case: "plugin", value: v } } }),
    emit: (i) => this.emit(i),
    threadExists: (id) => this.threads.has(id),
    sendToThread: (id, text) => {
      if (!this.threads.has(id)) throw new CommandError("notfound", `no thread ${id}`);
      this.logs.send(id, text, []);
    },
    registries: () => this.settings.value("plugins.registries"),
  });
  /** The Skills marketplace (mock/skills.ts); the EventService skill source. */
  readonly skills = new MockSkills({
    publish: (v) => this.events.publish({ source: EventSource.SKILL, event: { event: { case: "skill", value: v } } }),
    startSetup: (ctx, name, dir, script) => this.startSkillSetup(ctx, name, dir, script),
  });
  /** The app memory (mock/memory.ts); the EventService memory source. */
  readonly memory = new MockMemory({
    publish: (v) => this.events.publish({ source: EventSource.MEMORY, event: { event: { case: "memory", value: v } } }),
    emit: (i) => this.emit(i),
  });
  /** The user's themes (mock/userThemes.ts); the EventService theme source. */
  readonly themes: MockThemes = new MockThemes({
    publish: (v) => this.events.publish({ source: EventSource.THEME, event: { event: { case: "theme", value: v } } }),
    slot: (scheme) => this.settings.values()[`appearance.theme_${scheme}`] ?? "",
    setSlot: (scheme, id) => this.settings.update({ [`appearance.theme_${scheme}`]: id }),
    setScheme: (scheme) => this.settings.update({ "appearance.theme": scheme }),
    card: (threadId, card) => {
      this.logs.showTheme(threadId, card);
    },
    emit: (intent) => {
      this.emit(intent);
    },
  });
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
    (e) => this.projectEvents.publish(e),
  );
  /** EventService watchers that include UI intents (they count toward Emit's `delivered`). */
  uiEventWatchers = 0;
  /** ThreadService.StageAttachment uploads, by returned path. */
  attachments = new Map<string, { name: string; mimeType: string; size: number; pages: number }>();
  /** The bytes of staged PDFs, which ReadAttachment serves back (staged images read as the scripted PNG). */
  attachmentBytes = new Map<string, Uint8Array>();
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
    // Like the daemon: the theme slots list the user's themes first (store/usertheme).
    this.settings.userThemes = (scheme) => this.themes.choices(scheme);
    this.reset();
  }

  reset(): void {
    for (const t of this.terms.values()) t.attach.publish("end");
    this.terms.clear();
    this.projects.clear();
    this.workspaces.clear();
    this.invocations = [];
    this.attachments.clear();
    this.attachmentBytes.clear();
    this.logs.reset();
    this.worktreeDelayMs = 700;
    this.terminalNewDelayMs = 0;
    this.terminalNewFail = null;
    this.generation++;
    this.gitops.reset();
    this.settings.reset();
    this.backdrops.reset();
    this.writes = [];
    this.resizes = [];
    this.nextId = 1;
    for (const r of initialProjects()) this.projects.set(r.id, r);
    this.gh.reset();
    this.plugins.reset();
    this.skills.reset();
    this.memory.reset();
    this.themes.reset();
    const started = new Date(Date.now() - 42 * 60_000);
    // A shell terminal.new started on the Projects page for feat/sidebar (worktree-owned).
    this.addTerm({ id: "t-top", argv: ["top"], cwd: `${CFW}/feat-sidebar`, title: "", kind: "top", labels: shellLabels("", "repo-cf", `${CFW}/feat-sidebar`), startedAt: started });
    // A shell terminal.new started in thread s-1 (thread-owned: s-1's bottom panel).
    this.addTerm({ id: "t-s1-shell", argv: ["/bin/zsh", "-l"], cwd: CF, title: "", kind: "shell", labels: shellLabels("s-1", "repo-cf", CF), startedAt: started });
    // Threads in every state, each with a short history (SEEDS).
    this.threads.clear();
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    this.addThread({ id: "s-1", projectId: "repo-cf", worktreePath: CF, name: "Refactor sidebar tree", model: "claude-opus-4-8[1m]", effort: "high", status: ThreadStatus.BUSY, statusReason: "working: Refactor sidebar tree", createdAt: ago(42), usage: sampleUsage() });
    this.addThread({ id: "s-2", projectId: "repo-gp", worktreePath: GP, name: "Port renderer", model: "claude-sonnet-5[1m]", effort: "", status: ThreadStatus.NEEDS_ATTENTION, statusReason: `permission: Bash ${SEEDS["s-2"]?.reply ?? ""}`, statusChangedAt: ago(3), createdAt: ago(40) });
    this.addThread({ id: "s-3", projectId: "repo-cf", worktreePath: `${CFW}/fix-resize`, name: "Fix resize race", model: "claude-opus-4-8[1m]", effort: "medium", state: ThreadState.DISCONNECTED, disconnectReason: "idle", createdAt: ago(300), lastActivityAt: ago(95), usage: pageUsage("s-3") });
    this.addThread({ id: "s-4", projectId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Investigate flaky e2e", model: "claude-4.5-haiku[1m]", effort: "", state: ThreadState.DISCONNECTED, disconnectReason: "crashed", exitCode: 139, createdAt: ago(200), lastActivityAt: ago(17), usage: pageUsage("s-4") });
    this.addThread({ id: "s-5", projectId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Write thread docs", model: "claude-opus-4-8[1m]", effort: "low", state: ThreadState.STARTING, settleIn: 8, createdAt: ago(0) });
    this.addThread({ id: "s-6", projectId: "repo-dot", worktreePath: `${HOME}/dotfiles`, name: "Tidy zshrc", model: "claude-sonnet-5[1m]", effort: "", state: ThreadState.CLOSING, settleIn: 8, createdAt: ago(60) });
    // Archived 90 min ago (the sidebar's Archived section, collapsed by default).
    this.addThread({ id: "s-7", projectId: "repo-cf", worktreePath: CF, name: "Spike a canvas sidebar", model: "claude-sonnet-5[1m]", effort: "", state: ThreadState.DISCONNECTED, disconnectReason: "closed", status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", statusChangedAt: ago(95), createdAt: ago(600), lastActivityAt: ago(95), archivedAt: ago(90) });
    // Snoozed (the sidebar's Snoozed section, collapsed by default): s-8 wakes in 2.5 h (a
    // finished turn, so it does not count as attention while snoozed), s-9 in 4 days.
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    this.addThread({ id: "s-8", projectId: "repo-cf", worktreePath: CF, name: "Refactor the gh poller", model: "claude-sonnet-5[1m]", effort: "", state: ThreadState.DISCONNECTED, disconnectReason: "closed", status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", statusChangedAt: ago(30), createdAt: ago(500), lastActivityAt: ago(30), snoozedUntil: later(150) });
    this.addThread({ id: "s-9", projectId: "repo-gp", worktreePath: GP, name: "Bump wails to v3.1", model: "claude-opus-4-8[1m]", effort: "medium", state: ThreadState.DISCONNECTED, disconnectReason: "closed", createdAt: ago(450), lastActivityAt: ago(20), snoozedUntil: later(4 * 24 * 60 + 60) });
    // The hello plugin's own assistant thread and clock terminal (its demo's Assistant and
    // Shell tabs; docs/notes/plugins-6-thread-terminal.md): hidden from the user's lists.
    this.addThread({ id: HELLO_THREAD, projectId: "", worktreePath: `${HOME}/.code-foundry/plugin-data/hello`, name: "Hello assistant", model: "claude-haiku-5-5[1m]", effort: "low", state: ThreadState.DISCONNECTED, disconnectReason: "idle", status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", statusChangedAt: ago(2), createdAt: ago(3), lastActivityAt: ago(2), owner: "plugin:hello", usage: sampleUsage() });
    this.addTerm({ id: HELLO_TERMINAL, argv: ["sh", "-c", "while true; do date; sleep 2; done"], cwd: `${HOME}/.code-foundry/plugin-data/hello`, title: "", kind: "clock", labels: { kind: "plugin", plugin: "hello", title: "Clock" }, startedAt: ago(3) });
    for (const [id, h] of Object.entries(SEEDS)) if (h) this.logs.seed(id, h);
    // Republish so connected watchers converge on the reset state.
    for (const t of this.terms.values()) this.termEvents.publish({ event: { case: "updated", value: this.terminalMsg(t) } });
    for (const r of this.projects.values()) this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(r) } });
    this.workspaceEvents.publish(this.workspaceSnapshot());
    this.threadListEvents.publish(this.threadListSnapshot());
    this.actions.reset();
    this.update.reset();
    this.emberSettings = this.emberSettingsKey();
    this.ember.reset();
  }

  private emberSettingsKey(): string {
    return `${this.settings.value("ember.enabled")}|${this.settings.value("ember.epoch_context_tokens")}`;
  }

  /** ember.enabled on adds the resident thread and its workers; a change to what the board shows republishes it. */
  private emberSettingsChanged(): void {
    const key = this.emberSettingsKey();
    if (key === this.emberSettings) return;
    this.emberSettings = key;
    if (this.settings.value("ember.enabled") === "true") this.addEmberWorkers();
    this.ember.changed();
  }

  // ---- Workspaces ---------------------------------------------------------------

  /** <config home>/workspaces/<id>. */
  managedDirOf(w: MockWorkspace): string {
    return `${HOME}/.code-foundry/workspaces/${w.id}`;
  }

  /** Where a thread whose primary is the workspace runs: its root, else its managed dir. */
  workspaceDirOf(w: MockWorkspace): string {
    return w.rootPath || this.managedDirOf(w);
  }

  /**
   * WorkspaceService's Workspace (docs/notes/workspaces-v2-2-workspaces.md): member project
   * ids sorted, root, default primary, managed dir, and what the managed dir holds (the
   * instructions file, a rooted workspace's under its root; the skills).
   */
  workspaceMsg(w: MockWorkspace): WorkspaceInit {
    return {
      id: w.id,
      name: w.name,
      members: [...w.members].sort(),
      rootPath: w.rootPath,
      rootMissing: w.rootMissing === true,
      defaultPrimary: w.defaultPrimary,
      managedDir: this.managedDirOf(w),
      instructions: w.instructions ? `${this.workspaceDirOf(w)}/${w.instructions}` : "",
      skills: [...w.skills].sort(),
      createdAt: timestampFromDate(w.createdAt),
    };
  }

  private publishWorkspace(w: MockWorkspace): void {
    this.workspaceEvents.publish({ event: { case: "updated", value: this.workspaceMsg(w) } });
  }

  workspaceSnapshot(): WorkspaceEventInit {
    const list = [...this.workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { event: { case: "snapshot", value: { workspaces: list.map((w) => this.workspaceMsg(w)) } } };
  }

  /** A project by id or (unique) name, like the daemon's project refs. */
  private projectRef(ref: string): MockProject {
    const r = this.projects.get(ref) ?? [...this.projects.values()].find((x) => x.name === ref);
    if (!r) throw new CommandError("notfound", `project ${ref} not found`);
    return r;
  }

  /**
   * A worktree on `branch` whose work is in origin/<default> and that has no changes
   * (cleanable unless something holds it). `path`: put it there instead, e.g. outside the
   * app's worktrees directory, as another tool would (then it is never cleanable).
   */
  addMergedWorktree(projectRef: string, branch: string, path = ""): MockWorktree {
    const project = this.projectRef(projectRef);
    const w = this.addWorktree(project, branch, `origin/${project.defaultBranch || "main"}`);
    if (path) {
      w.path = path;
      this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(project) } });
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
    // Like the daemon's checkoutThreads: another thread's checkout holds it too.
    for (const t of this.threads.values()) {
      if (t.archivedAt !== null) continue;
      if (this.checkoutsOf(t).some((c) => !c.missing && c.path === path)) return t.name ? `thread ${t.name} is on it` : "a thread is on it";
    }
    return "";
  }

  /** ProjectService.CleanupWorktrees: what project.worktree.cleanup removes (dry: only says so) and what it keeps, with why. */
  cleanupWorktrees(projectRef: string, path: string, dry: boolean): { removed: MockWorktree[]; skipped: { w: MockWorktree; reason: string }[] } {
    const project = this.projectRef(projectRef);
    requireGit(project, "a cleanup");
    const candidates = path ? project.worktrees.filter((w) => w.path === path) : project.worktrees.filter((w) => !w.isMain);
    if (path && candidates.length === 0) throw new CommandError("notfound", `worktree ${path} in project ${project.name}`);
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

  /** Where the daemon makes `project`'s worktree for `branch` (DefaultWorktreePath). */
  private worktreePathFor(project: MockProject, branch: string): string {
    return `${HOME}/.code-foundry/worktrees/${project.githubSlug || `_local/${project.name}`}/${branch.replace(/\//g, "-")}`;
  }

  /** A new worktree on `branch` in `project` (published), where the daemon would put it. */
  private addWorktree(project: MockProject, branch: string, baseRef: string): MockWorktree {
    requireGit(project, "a new worktree");
    const w: MockWorktree = {
      path: this.worktreePathFor(project, branch),
      branch,
      head: "c0ffee00",
      isMain: false,
      status: clean({ upstream: "", baseRef }),
    };
    project.worktrees.push(w);
    this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
    return w;
  }

  /**
   * workspace.new like the daemon: names unique whatever their case ("workspace" is the
   * primary keyword), members by id or name, sorted; the default primary is `primary`, else
   * "workspace" for a rooted one (or one without projects), else the first project given.
   * Nothing on disk changes. Test control: POST /__mock/workspace (with instructions and
   * skills, as a thread would have written them).
   */
  addWorkspace(name: string, refs: readonly string[], o: { root?: string; primary?: string; instructions?: string; skills?: readonly string[] } = {}): MockWorkspace {
    const n = name.trim();
    if (!n) throw new CommandError("invalid", "argument \"name\": a workspace needs a name");
    if (n.toLowerCase() === "workspace") throw new CommandError("invalid", "\"workspace\" is reserved: it names a workspace's own folder as a primary");
    this.nameFree(n, "");
    const root = (o.root ?? "").trim();
    const given = refs.map((r) => this.projectRef(r.split(":")[0]?.trim() ?? "").id);
    if (given.length === 0 && !root) throw new CommandError("invalid", "a workspace needs at least one project or a root folder");
    const w: MockWorkspace = {
      id: `w-${String(this.workspaces.size + 1).padStart(12, "0")}`,
      name: n,
      members: [...new Set(given)].sort(),
      rootPath: root,
      defaultPrimary: "workspace",
      instructions: o.instructions ?? "",
      skills: [...(o.skills ?? [])].sort(),
      createdAt: new Date(),
    };
    if (o.primary) w.defaultPrimary = this.primaryOf(w, o.primary);
    else if (!root && given[0]) w.defaultPrimary = given[0];
    this.workspaces.set(w.id, w);
    this.publishWorkspace(w);
    return w;
  }

  /** The daemon's nameFree: no other workspace has the name, whatever its case. */
  private nameFree(name: string, except: string): void {
    const other = [...this.workspaces.values()].find((w) => w.id !== except && w.name.toLowerCase() === name.toLowerCase());
    if (other) throw new CommandError("unavailable", `a workspace named "${other.name}" exists`);
  }

  /** A default primary ref: "workspace", or a member by id or name. */
  private primaryOf(w: MockWorkspace, ref: string): string {
    if (ref.trim().toLowerCase() === "workspace") return "workspace";
    const id = this.projectRef(ref.trim()).id;
    if (!w.members.includes(id)) throw new CommandError("unavailable", `${ref} is not in workspace ${w.name}`);
    return id;
  }

  private workspaceRef(ref: string): MockWorkspace {
    const w = this.workspaces.get(ref) ?? [...this.workspaces.values()].find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!w) throw new CommandError("notfound", `workspace ${ref} not found`);
    return w;
  }

  /** workspace.rename. */
  renameWorkspace(ref: string, name: string): MockWorkspace {
    const w = this.workspaceRef(ref);
    const n = name.trim();
    if (!n) throw new CommandError("invalid", "argument \"name\": a workspace needs a name");
    if (n.toLowerCase() === "workspace") throw new CommandError("invalid", "\"workspace\" is reserved: it names a workspace's own folder as a primary");
    this.nameFree(n, w.id);
    w.name = n;
    this.publishWorkspace(w);
    return w;
  }

  /** workspace.set-primary. */
  setWorkspacePrimary(ref: string, primary: string): MockWorkspace {
    const w = this.workspaceRef(ref);
    w.defaultPrimary = this.primaryOf(w, primary);
    this.publishWorkspace(w);
    return w;
  }

  /** Test control: what a thread wrote into the workspace's folder (its instructions file, its skills). POST /__mock/workspace-files. */
  setWorkspaceFiles(ref: string, instructions: string | undefined, skills: readonly string[] | undefined, rootMissing?: boolean): MockWorkspace {
    const w = this.workspaceRef(ref);
    if (instructions !== undefined) w.instructions = instructions;
    if (skills !== undefined) w.skills = [...skills].sort();
    if (rootMissing !== undefined) w.rootMissing = rootMissing;
    this.publishWorkspace(w);
    return w;
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
    for (const id of [...this.projects.keys()]) {
      this.actions.removeProject(id);
      this.projectEvents.publish({ event: { case: "projectRemovedId", value: id } });
    }
    this.projects.clear();
    this.workspaceEvents.publish(this.workspaceSnapshot());
    this.threadListEvents.publish(this.threadListSnapshot());
  }

  /** Test control: `count` connected project threads with `status` in `project`'s main worktree. POST /__mock/threads. */
  addThreads(project: string, count: number, status: ThreadStatus, prefix: string): MockThread[] {
    const r = this.projectRef(project);
    const path = r.worktrees.find((w) => w.isMain)?.path ?? r.path;
    const out: MockThread[] = [];
    for (let i = 1; i <= count; i++) {
      const s = this.addThread({ id: `s-t-${String(this.nextId++)}`, projectId: r.id, worktreePath: path, name: `${prefix} ${String(i)}`, model: "claude-4.5-haiku[1m]", effort: "", status, createdAt: new Date() });
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
      const s = this.addThread({ projectId: "repo-cf", worktreePath: CF, model: "claude-4.5-haiku[1m]", effort: "medium", createdAt: ago(min + 5), lastActivityAt: ago(min), statusChangedAt: ago(min), ...k });
      this.publishThread(s);
    }
    return out;
  }

  /**
   * Scenario: the resident thread "ember" (docs/notes/ember-1-primitives.md): the daemon's
   * own agent, stopped, in its own directory, in its second epoch, with no project. Kept
   * out of the sidebar and the counts like a plugin's thread. POST /__mock/resident.
   * Idempotent; returns its id.
   */
  addResident(): string {
    const id = "s-resident-ember";
    if (!this.threads.has(id)) {
      const ago = (min: number) => new Date(Date.now() - min * 60_000);
      const s = this.addThread({ id, projectId: "", worktreePath: `${HOME}/.code-foundry/residents/ember`, name: "Ember", model: "claude-opus-4-8[1m]", effort: "high",
        state: ThreadState.DISCONNECTED, disconnectReason: "idle", status: ThreadStatus.IDLE, statusReason: "at prompt", statusChangedAt: ago(4), createdAt: ago(600),
        lastActivityAt: ago(4), resident: "ember", epoch: 2, held: true });
      this.logs.seedEmber(id);
      this.publishThread(s);
      this.ember.changed();
    }
    return id;
  }

  /**
   * POST /__mock/ember/restart (docs/notes/ember-fixes-2-gui.md): "cut", the app's restart
   * cuts a turn of Ember's, as the daemon's shutdown does (a tool it stopped under, a
   * process_ended turn end, error "interrupted"); "wake", the restart notice wakes Ember and
   * it replies (finished).
   */
  emberRestart(step: "cut" | "wake"): void {
    const id = this.addResident();
    if (step === "cut") {
      this.logs.emberRestartCut(id);
      this.stopThread(id, "daemon stopped", 0, ThreadStatus.BUSY);
      return;
    }
    this.logs.emberRestartWake(id);
    const s = this.thread(id);
    s.state = ThreadState.CONNECTED;
    this.setStatus(s, ThreadStatus.NEEDS_ATTENTION, "finished");
    s.lastActivityAt = new Date();
    this.publishThread(s);
  }

  /**
   * Ember turned on (ember.enabled, POST /__mock/ember?enabled=true): the resident thread and
   * the seeded tasks' worker threads (mock/ember.ts), created by it, so hidden from the
   * sidebar while threads.show_created_threads is off. Held. Idempotent.
   */
  addEmberWorkers(): void {
    const resident = this.addResident();
    for (const w of emberWorkers()) {
      if (this.threads.has(w.id)) continue;
      const s = this.addThread({ id: w.id, projectId: "repo-cf", worktreePath: CF, name: w.name, model: w.model, effort: "high", state: w.state, status: w.status, statusReason: w.statusReason,
        statusChangedAt: w.lastActivityAt, createdAt: w.createdAt, lastActivityAt: w.lastActivityAt, createdBy: w.createdBy ?? resident,
        createdByName: w.createdBy ? (emberWorkers().find((x) => x.id === w.createdBy)?.name ?? "") : "Ember", brief: w.brief, held: true });
      this.publishThread(s);
    }
  }

  /**
   * Scenario: thread lineage (docs/notes/agents-3-lineage-gui.md). "Fix login redirect"
   * (working) created "Add retry to login redirect" (finished; its log starts with the
   * daemon's "Created by" note) and six siblings of it, one archived, so the Threads tab
   * caps them at five; "Add retry…" created "Write retry backoff tests". All held (the
   * clock leaves them alone). Every created thread follows threads.show_created_threads
   * (hidden from the sidebar by default) except "Tidy redirect logging", shown by its
   * override (docs/notes/hidden-children-2-gui.md). POST /__mock/lineage. Idempotent.
   * Returns the ids, creator first, then the child, its siblings and its child in spawn
   * order.
   */
  addLineage(): string[] {
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const A = ThreadStatus.NEEDS_ATTENTION;
    const D = ThreadState.DISCONNECTED;
    const P = "s-l-parent";
    const PN = "Fix login redirect";
    const C = "s-l-child";
    const CN = "Add retry to login redirect";
    // Models and efforts vary, for the Threads tab's model words (docs/notes/threads-tab-model.md); Haiku 4.5 at medium otherwise.
    type Spec = Partial<MockThread> & Pick<MockThread, "id" | "name"> & { min: number };
    const specs: Spec[] = [
      { id: P, name: PN, model: "claude-opus-4-8[1m]", effort: "high", status: ThreadStatus.BUSY, statusReason: "working", min: 41, worktreePath: `${CFW}/feat-sidebar` },
      { id: C, name: CN, model: "claude-sonnet-5[1m]", effort: "high", createdBy: P, createdByName: PN, brief: "Add retry to the login redirect, keep the PR small", status: A, statusReason: "finished", state: D, min: 18, worktreePath: `${CFW}/fix-resize`, labels: ["auth"] },
      { id: "s-l-e2e", name: "Update redirect e2e tests", model: "claude-haiku-5-5[1m]", createdBy: P, createdByName: PN, brief: "Cover the new retry path in the redirect e2e suite", status: ThreadStatus.BUSY, statusReason: "working", min: 17 },
      { id: "s-l-cookie", name: "Audit session cookie flags", model: "claude-sonnet-5[1m]", effort: "low", createdBy: P, createdByName: PN, brief: "Check SameSite and Secure on the session cookie in every env; report, don't fix", status: A, statusReason: "permission: Bash", min: 15, projectId: "repo-gp", worktreePath: GP },
      { id: "s-l-allow", name: "Bump redirect allowlist", model: "claude-opus-4-7[1m]", effort: "xhigh", createdBy: P, createdByName: PN, brief: "Add staging.acme.dev to the redirect allowlist and its test", status: A, statusReason: "error: overloaded", state: D, min: 14 },
      { id: "s-l-spike", name: "Old redirect spike", createdBy: P, createdByName: PN, status: A, statusReason: "finished", state: D, min: 13, archivedAt: ago(5) },
      // Handed to the user (thread.sidebar --shown=true): shown in the sidebar whatever the setting, and kept when P is archived.
      { id: "s-l-logs", name: "Tidy redirect logging", model: "claude-sonnet-4-6[1m]", effort: "low", createdBy: P, createdByName: PN, brief: "Drop the debug logs around the redirect", state: D, min: 12, inSidebar: true },
      { id: "s-l-metrics", name: "Check redirect metrics", model: "claude-haiku-5-5[1m]", createdBy: P, createdByName: PN, state: D, min: 11 },
      // Its creator was renamed since (the recorded name differs): the GUI shows the current one.
      { id: "s-l-grand", name: "Write retry backoff tests", model: "claude-haiku-5-5[1m]", effort: "low", createdBy: C, createdByName: `${CN} (old)`, brief: "Write table tests for the retry backoff schedule (3 attempts, 200 ms base)", state: D, min: 9, worktreePath: `${CFW}/fix-resize` },
    ];
    const out: string[] = [];
    for (const { min, ...o } of specs) {
      out.push(o.id);
      if (this.threads.has(o.id)) continue;
      const s = this.addThread({ projectId: "repo-cf", worktreePath: CF, model: "claude-4.5-haiku[1m]", effort: "medium", createdAt: ago(min), lastActivityAt: ago(min - 1), statusChangedAt: ago(min - 1), held: true, ...o });
      if (s.id === P) {
        // The creator was woken when its child settled (thread.new --notify): a wake message.
        const payload = {
          kind: "thread",
          subscription_id: "sub-l-1",
          condition: "settled",
          fired_at: ago(min - 20).toISOString(),
          thread: { id: C, name: CN, state: "disconnected", status: "needs_attention", status_reason: "finished", project_id: "repo-cf", worktree_path: `${CFW}/fix-resize`, created_by: P, labels: ["auth"], report: { status: "done", summary: "Retry added around exchangeToken, 3 attempts; PR opened", data: { pr: 412 }, at: ago(min - 20).toISOString() } },
        };
        this.logs.seed(s.id, {
          prompt: "Split the login redirect fix into threads with code-foundry thread new, and wake me when they settle.",
          intro: "Starting the threads.",
          command: `code-foundry thread new --repo code-foundry --brief "Add retry to the login redirect" "Add a bounded retry"`,
          output: `created thread ${CN} (${C})`,
          reply: "Started seven threads; I'll pick up their reports as they finish.",
          minutesAgo: min,
          end: "done",
          wakes: [{ title: `Thread "${CN}" (${C}) is idle: finished. Report: done — Retry added around exchangeToken, 3 attempts; PR opened.`, json: JSON.stringify(payload, null, 2) }],
        });
      }
      if (s.createdBy) {
        this.logs.seed(s.id, {
          note: { id: "note-created-by", text: `Created by ${s.createdByName}${s.brief ? ` · brief: ${s.brief}` : ""}`, createdBy: s.createdBy },
          prompt: s.brief || s.name,
          intro: "Reading the redirect handler first.",
          command: "rg -n exchangeToken internal/auth",
          output: "internal/auth/redirect.go:42:\ttok, err := exchangeToken(ctx, code)",
          reply: "Done: the retry wraps exchangeToken with three attempts.",
          minutesAgo: min,
          end: "done",
        });
      }
      this.publishThread(s);
    }
    return out;
  }

  /**
   * Test control: a connected worktree-mode thread that references the workspace, its
   * members as its set, on branch cf/<workspace name> (each git member's worktree made, as
   * a spawn would), in `project`'s (else the default primary's; "workspace": its folder).
   * POST /__mock/workspace-thread.
   */
  addWorkspaceThread(workspace: string, project: string, name: string, status: ThreadStatus = ThreadStatus.IDLE): MockThread {
    const ws = this.workspaceRef(workspace);
    const primary = project ? (project === "workspace" ? "workspace" : this.projectRef(project).id) : ws.defaultPrimary;
    if (primary !== "workspace" && !ws.members.includes(primary)) throw new CommandError("unavailable", `project ${project} is not in workspace ${ws.name}`);
    const branch = `cf/${ws.name}`;
    let cwd = primary === "workspace" ? this.workspaceDirOf(ws) : "";
    for (const id of ws.members) {
      const r = this.projectRef(id);
      const path = r.git === false ? r.path : (r.worktrees.find((w) => w.branch === branch)?.path ?? this.addWorktree(r, branch, r.remotes.length > 0 ? `origin/${r.defaultBranch}` : r.defaultBranch).path);
      if (id === primary) cwd = path;
    }
    const s = this.addThread({ id: `s-ws-${String(this.nextId++)}`, projectId: primary === "workspace" ? "" : primary, worktreePath: cwd, projectIds: [...ws.members], branch, createdWorktree: true, name, model: "claude-4.5-haiku[1m]", effort: "", workspaceId: ws.id, status, createdAt: new Date() });
    this.publishThread(s);
    return s;
  }

  /**
   * Test control: a connected worktree-mode thread over `projects` on `branch`, its
   * worktrees made in every git project now (the daemon makes them at spawn), running in
   * `project`'s (else the first's). POST /__mock/multi-thread.
   */
  addMultiThread(refs: readonly string[], project: string, branch: string, name: string, workspace = ""): MockThread {
    const ids = refs.map((r) => this.projectRef(r).id);
    if (ids.length === 0) throw new CommandError("invalid", "name the projects");
    const primary = project ? this.projectRef(project).id : (ids[0] ?? "");
    if (!ids.includes(primary)) throw new CommandError("invalid", `${project} is not one of the projects`);
    let cwd = "";
    for (const id of ids) {
      const r = this.projectRef(id);
      const path = r.git === false ? r.path : (r.worktrees.find((w) => w.branch === branch)?.path ?? this.addWorktree(r, branch, r.remotes.length > 0 ? `origin/${r.defaultBranch}` : r.defaultBranch).path);
      if (id === primary) cwd = path;
    }
    const ws = workspace ? this.workspaceRef(workspace) : undefined;
    const s = this.addThread({ id: `s-mp-${String(this.nextId++)}`, projectId: primary, worktreePath: cwd, projectIds: ids, branch, createdWorktree: true, name, model: "claude-4.5-haiku[1m]", effort: "", workspaceId: ws?.id ?? "", createdAt: new Date() });
    this.publishThread(s);
    return s;
  }

  /** Test control: a thread's project set. POST /__mock/thread/project-ids. */
  setThreadProjectIds(id: string, ids: readonly string[]): MockThread {
    const s = this.thread(id);
    s.projectIds = ids.map((r) => this.projectRef(r).id);
    this.publishThread(s);
    return s;
  }

  /** A project's main worktree (its folder without git). */
  private mainPathOf(projectId: string): string {
    const r = this.projectRef(projectId);
    return r.worktrees.find((w) => w.isMain)?.path ?? r.path;
  }

  /**
   * thread.run-in like the daemon: the target is one of the thread's checkouts (by project
   * or path) or "workspace" (its workspace's folder). A stopped thread moves at once; a
   * running one gets the target as pendingWorktreePath and moves ~2s after it stops being
   * busy (MockThread.moveIn). Asking for the current checkout cancels a queued move.
   */
  runIn(s: MockThread, projectRef: string, worktree: string): MockThread {
    const target = this.runInTarget(s, projectRef, worktree);
    if (s.state === ThreadState.CLOSING) throw new CommandError("unavailable", `thread ${s.id} is closing`);
    if (s.state === ThreadState.DISCONNECTED || target.path === s.worktreePath) {
      s.pendingWorktreePath = "";
      s.worktreePath = target.path;
      s.projectId = target.projectId;
    } else {
      s.pendingWorktreePath = target.path;
      s.moveIn = 2;
    }
    this.publishThread(s);
    return s;
  }

  private runInTarget(s: MockThread, projectRef: string, worktree: string): { projectId: string; path: string } {
    const ws = s.workspaceId ? this.workspaces.get(s.workspaceId) : undefined;
    if (projectRef === "workspace" || (ws && worktree && worktree === this.workspaceDirOf(ws))) {
      if (!ws) throw new CommandError("unavailable", `thread ${s.id} has no workspace`);
      return { projectId: "", path: this.workspaceDirOf(ws) };
    }
    const cos = this.checkoutsOf(s).filter((c) => c.path);
    if (cos.length < 2 && !ws) throw new CommandError("unavailable", `thread ${s.id} has one checkout`);
    const c = worktree ? cos.find((x) => x.path === worktree) : cos.find((x) => x.projectId === this.projectRef(projectRef).id);
    if (!c) throw new CommandError("unavailable", `${projectRef || worktree} is not one of thread ${s.id}'s checkouts`);
    return { projectId: c.projectId, path: c.path };
  }

  private applyMove(s: MockThread): void {
    const path = s.pendingWorktreePath;
    s.pendingWorktreePath = "";
    const ws = s.workspaceId ? this.workspaces.get(s.workspaceId) : undefined;
    const c = this.checkoutsOf(s).find((x) => x.path === path);
    if (c) {
      s.worktreePath = c.path;
      s.projectId = c.projectId;
    } else if (ws && path === this.workspaceDirOf(ws)) {
      s.worktreePath = path;
      s.projectId = "";
    }
    this.publishThread(s);
  }

  /** workspace.add-project: nothing on disk changes. */
  addWorkspaceProject(workspace: string, projectRef: string): MockWorkspace {
    const ws = this.workspaceRef(workspace);
    const project = this.projectRef(projectRef);
    if (ws.members.includes(project.id)) throw new CommandError("unavailable", `${project.name} is already in workspace ${ws.name}`);
    ws.members = [...ws.members, project.id].sort();
    this.publishWorkspace(ws);
    return ws;
  }

  /** Live threads whose cwd is in one of these worktrees (the daemon's removal guard). */
  private threadsIn(paths: readonly string[]): MockThread[] {
    // The daemon's worktreeThreads: every thread but an archived one, whatever its state.
    return [...this.threads.values()].filter((s) => s.archivedAt === null && paths.some((p) => s.worktreePath === p || s.worktreePath.startsWith(`${p}/`)));
  }

  private dropWorktree(path: string): void {
    for (const project of this.projects.values()) {
      if (!project.worktrees.some((w) => w.path === path)) continue;
      project.worktrees = project.worktrees.filter((w) => w.path !== path);
      this.projectEvents.publish({ event: { case: "worktreeRemoved", value: { projectId: project.id, path } } });
    }
    this.closeShells((l) => l[LABEL_WORKTREE] === path);
    this.actions.stopBackground((r) => r.worktreePath === path);
  }

  /** workspace.remove-project: nothing on disk changes; a default primary that was the project becomes "workspace". */
  removeWorkspaceProject(workspace: string, projectRef: string): MockWorkspace {
    const ws = this.workspaceRef(workspace);
    // Like the daemon's memberRef: a member's id first (an unregistered one too), else a project ref.
    const id = ws.members.includes(projectRef) ? projectRef : this.projectRef(projectRef).id;
    if (!ws.members.includes(id)) throw new CommandError("unavailable", `${projectRef} is not in workspace ${ws.name}`);
    ws.members = ws.members.filter((m) => m !== id);
    if (ws.defaultPrimary === id) ws.defaultPrimary = "workspace";
    this.publishWorkspace(ws);
    return ws;
  }

  /** workspace.remove: the workspace (a synthetic one's managed dir with it); threads keep their projects. */
  removeWorkspace(workspace: string): void {
    const ws = this.workspaceRef(workspace);
    this.workspaces.delete(ws.id);
    this.workspaceEvents.publish({ event: { case: "removedId", value: ws.id } });
  }

  // ---- Threads -----------------------------------------------------------------

  private addThread(o: Partial<MockThread> & Pick<MockThread, "id" | "projectId" | "worktreePath" | "name" | "model" | "effort">): MockThread {
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
      createdBy: "",
      createdByName: "",
      inSidebar: null,
      brief: "",
      labels: [],
      permissionMode: PermissionMode.AUTO,
      baseRef: "",
      createdWorktree: false,
      projectIds: [],
      branch: "",
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
      flags: [],
      owner: "",
      resident: "",
      epoch: 1,
      pluginEnvChange: "",
      ...o,
      state,
    };
    this.threads.set(s.id, s);
    return s;
  }

  /** Thread.project_ids: the set and the primary, sorted (a workspace's members are copied into the set when the thread is made). */
  projectIdsOf(s: MockThread): string[] {
    const ids = new Set(s.projectIds);
    if (s.projectId) ids.add(s.projectId);
    return [...ids].sort();
  }

  /**
   * ThreadService.Checkouts' derivation (the daemon's CheckoutsOf): per project of the set,
   * by id, the primary at the thread's cwd; a plain folder the folder; in worktree mode a
   * git member's worktree on the thread's branch (missing when not made yet, at the path
   * the daemon would make it); otherwise its main worktree.
   */
  checkoutsOf(s: MockThread): MockCheckout[] {
    return this.projectIdsOf(s).map((id) => {
      const project = this.projects.get(id);
      if (!project) return { projectId: id, projectName: "", path: "", branch: "", primary: false, missing: false, git: false, derived: false };
      const base = { projectId: id, projectName: project.name, git: project.git !== false, derived: false, missing: false };
      if (id === s.projectId && project.worktrees.some((w) => s.worktreePath === w.path || s.worktreePath.startsWith(`${w.path}/`))) {
        const wt = project.worktrees.find((w) => s.worktreePath === w.path || s.worktreePath.startsWith(`${w.path}/`));
        return { ...base, path: wt?.path ?? s.worktreePath, branch: wt?.branch ?? "", primary: true, derived: s.createdWorktree && project.git !== false };
      }
      if (project.git === false) return { ...base, path: project.path, branch: "", primary: false };
      if (s.createdWorktree && s.branch) {
        const wt = project.worktrees.find((w) => w.branch === s.branch);
        return { ...base, path: wt?.path ?? this.worktreePathFor(project, s.branch), branch: s.branch, primary: false, missing: !wt, derived: true };
      }
      const main = project.worktrees.find((w) => w.isMain);
      return { ...base, path: main?.path ?? project.path, branch: main?.branch ?? "", primary: false };
    });
  }

  /** ThreadService.Checkouts for a thread by id. */
  checkoutsMsg(id: string) {
    const s = this.thread(id);
    const ws = s.workspaceId ? this.workspaces.get(s.workspaceId) : undefined;
    return {
      thread: this.threadMsg(s),
      checkouts: this.checkoutsOf(s).map((c) => ({ ...c, current: c.primary, instructions: "" })),
      workspaceId: s.workspaceId,
      workspaceName: ws?.name ?? "",
      workspaceDir: ws ? this.managedDirOf(ws) : "",
    };
  }

  threadMsg(s: MockThread): ThreadInit {
    return {
      id: s.id,
      claudeSessionId: s.claudeSessionId,
      projectId: s.projectId,
      projectIds: this.projectIdsOf(s),
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
      createdBy: s.createdBy,
      createdByName: s.createdByName,
      brief: s.brief,
      labels: s.labels,
      permissionMode: s.permissionMode,
      baseRef: s.baseRef,
      createdWorktree: s.createdWorktree,
      branch: s.branch,
      workspaceId: s.workspaceId,
      pendingWorktreePath: s.pendingWorktreePath,
      pinned: s.pinned,
      flags: s.flags.map((f) => ({ ...f, setAt: timestampFromDate(f.setAt) })),
      ...(s.owner ? { owner: s.owner } : {}),
      ...(s.resident ? { kind: ThreadKind.RESIDENT, residentName: s.resident } : {}),
      epoch: s.epoch,
      ...(s.pluginEnvChange ? { pluginEnvStale: true, pluginEnvChange: s.pluginEnvChange } : {}),
      ...(s.archivedAt ? { archivedAt: timestampFromDate(s.archivedAt) } : {}),
      ...(s.snoozedUntil ? { snoozedUntil: timestampFromDate(s.snoozedUntil) } : {}),
      ...(s.inSidebar !== null ? { inSidebar: s.inSidebar } : {}),
      effortPending: s.effortPending,
      linkedPullRequests: s.linkedPullRequests.map((l) => ({ slug: l.slug, number: l.number, url: l.url, linkedAt: timestampFromDate(l.linkedAt) })),
      ...usageFields(s.usage),
      ...contextFields(s, this.cacheTTLSeconds()),
      ...agentCounts(this.logs.agentRunsOf(s.id)),
      agentRuns: listRuns(this.logs.agentRunsOf(s.id)),
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
    if (this.ember.watches(s.id)) this.ember.changed();
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
    s.pluginEnvChange = ""; // the next start gets the current environment
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

  /**
   * A plugin raises (or with level none clears) its flag on a thread, like the daemon's
   * thread/setFlag: one per plugin, errors first then newest; an archived thread refuses.
   */
  setFlag(id: string, f: Omit<MockFlag, "setAt" | "level"> & { level: ThreadFlagLevel | null }): void {
    const s = this.thread(id);
    const rest = s.flags.filter((x) => x.plugin !== f.plugin);
    if (f.level === null) {
      s.flags = rest;
    } else {
      if (s.archivedAt) throw new CommandError("unavailable", "thread is archived");
      s.flags = [...rest, { ...f, level: f.level, setAt: new Date() }].sort((a, b) => b.level - a.level || b.setAt.getTime() - a.setAt.getTime());
    }
    this.publishThread(s);
  }

  /** A plugin's session environment changed (or, with "", is current again) for a running thread. */
  setPluginEnvChange(id: string, change: string): void {
    const s = this.thread(id);
    if (change && s.state !== ThreadState.CONNECTED) throw new CommandError("unavailable", "only a running thread can be stale");
    s.pluginEnvChange = change;
    this.publishThread(s);
  }

  /** ThreadService.Restart: a running thread restarts with the current environment; any other is left as it is. */
  restartThread(id: string): boolean {
    const s = this.thread(id);
    if (s.state !== ThreadState.CONNECTED && s.state !== ThreadState.STARTING) return false;
    this.logs.restart(id);
    s.pluginEnvChange = "";
    this.publishThread(s);
    return true;
  }

  /** ThreadService.ClearFlags: one plugin's flag, or every one with plugin empty; NOT_FOUND when there is none to clear. */
  clearFlags(id: string, plugin: string): number {
    const s = this.thread(id);
    const keep = s.flags.filter((f) => plugin !== "" && f.plugin !== plugin);
    const n = s.flags.length - keep.length;
    if (n === 0) throw new CommandError("notfound", `thread ${id} has no ${plugin ? `${plugin} ` : ""}flags`);
    s.flags = keep;
    this.publishThread(s);
    return n;
  }

  /** The user opened the thread: its until-seen flags go (the daemon's WatchItems). */
  seenFlags(id: string): void {
    const s = this.threads.get(id);
    if (!s || !s.flags.some((f) => f.untilSeen)) return;
    s.flags = s.flags.filter((f) => !f.untilSeen);
    this.publishThread(s);
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
      projectId: "repo-cf",
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
  private createThread(projectId: string, path: string, model: string, effort: string, extra: Partial<MockThread> = {}): MockThread {
    const id = `s-new-${String(this.nextId++)}`;
    // With a first prompt the thread is on that turn already (the daemon says busy at spawn).
    const busy = extra.firstMessage ? { status: ThreadStatus.BUSY, statusReason: "working" } : {};
    const s = this.addThread({ id, projectId, worktreePath: path, name: "", model, effort, state: ThreadState.STARTING, settleIn: 2, nameIn: 1, pendingName: `thread-${id}`, createdAt: new Date(), ...busy, ...extra });
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
      // Like the daemon: unarchiving does not cascade.
      s.archivedAt = null;
      this.publishThread(s);
      return `unarchived thread ${label}`;
    }
    // Like the daemon: the hidden threads below it go first, in tree order, then the thread.
    for (const c of this.archiveCascade(s.id)) if (c.archivedAt === null) this.archiveOne(c);
    this.archiveOne(s);
    return `archived thread ${label}`;
  }

  /** The sidebar rule (lib/inSidebar.ts, the daemon's Thread.InSidebar) with the mock's threads.show_created_threads. */
  inSidebar(s: MockThread): boolean {
    if (!s.createdBy) return true;
    if (s.inSidebar !== null) return s.inSidebar;
    return this.settings.values()["threads.show_created_threads"] === "true";
  }

  /**
   * The threads archiving `root` takes with it (the daemon's ArchiveCascade): its
   * descendants in tree order (spawn order, 8 levels, cycle safe) whose every ancestor
   * below the root is hidden, archived ones included (archiving skips them; they keep
   * their hidden children reachable). A shown thread and everything under it stay.
   */
  archiveCascade(root: string): MockThread[] {
    const out: MockThread[] = [];
    const seen = new Set([root]);
    const walk = (id: string, depth: number) => {
      if (depth > 8) return;
      const kids = [...this.threads.values()].filter((t) => t.createdBy === id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      for (const c of kids) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (this.inSidebar(c)) continue;
        out.push(c);
        walk(c.id, depth + 1);
      }
    };
    walk(root, 1);
    return out;
  }

  /** The unarchived threads archiving `root` takes with it that are mid-turn (thread.archive's confirmation; the daemon's hiddenWorking). */
  private hiddenWorking(root: string): MockThread[] {
    return this.archiveCascade(root).filter((t) => t.archivedAt === null && midTurn(t) !== "");
  }

  /** Archives one thread (no cascade): closes Claude, removes its shells, unpins, unsnoozes, stamps it. */
  private archiveOne(s: MockThread): void {
    if (s.state !== ThreadState.DISCONNECTED) this.stopThread(s.id, "closed", 0);
    this.closeShells((l) => l[LABEL_THREAD] === s.id);
    s.pinned = false;
    s.archivedAt ??= new Date();
    s.snoozedUntil = null;
    s.flags = [];
    this.publishThread(s);
  }

  /**
   * thread.sidebar (POST /__mock/thread/sidebar does what the CLI does): shows (true) or
   * hides (false) a thread another thread created, whatever the setting says; refused for
   * the user's own thread, like the daemon.
   */
  setThreadSidebar(id: string, shown: boolean): string {
    const s = this.thread(id);
    const label = s.name ? `${s.name} (${s.id})` : s.id;
    if (!s.createdBy) throw new CommandError("invalid", `thread ${s.id}: invalid argument: only a thread another thread created can be shown or hidden in the sidebar; one the user created is always shown`);
    s.inSidebar = shown;
    this.publishThread(s);
    return `thread ${label} ${shown ? "shown in" : "hidden from"} the sidebar`;
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
      case "clock":
        t.history = Array.from({ length: 6 }, (_, i) => `${clockLine(new Date(Date.now() - (6 - i) * 2000))}\r\n`).join("");
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
      if (t.kind === "clock" && t.tick % 2 === 0) this.output(t, `${clockLine(new Date())}\r\n`);
    }
    if (this.seconds % 8 === 0) {
      const project = this.projects.get("repo-cf");
      const w = project?.worktrees.find((x) => x.branch === "feat/sidebar");
      if (project && w) {
        w.status.modified = w.status.modified === 3 ? 4 : 3;
        this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
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
    // A skill's setup script: exit 0 is setup done (the daemon's skill_setup_exits.go).
    if (t.labels[LABEL_KIND] === KIND_SETUP) this.skills.setupExited(t.labels.skill ?? "", code);
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
  /**
   * skill.setup's terminal, like the daemon's: owned by the context's thread, else its
   * worktree, else its project's main worktree (null with none); kind=setup with the
   * skill and its tab's title. The script prints a few lines and exits 0 about a second
   * later, which marks the skill set up (kill → MockSkills.setupExited).
   */
  private startSkillSetup(ctx: UiContext | undefined, name: string, dir: string, script: string): { id: string; cwd: string; labels: Record<string, string> } | null {
    let labels: Record<string, string>;
    if (ctx?.activeThreadId || ctx?.activeWorktreePath) labels = this.shellOwner(ctx, "").labels;
    else {
      const p = ctx?.activeProjectId ? this.projects.get(ctx.activeProjectId) : undefined;
      if (!p) return null;
      labels = shellLabels("", p.id, p.path);
    }
    const t = this.create(["/bin/sh", script], dir, { ...labels, [LABEL_KIND]: KIND_SETUP, skill: name, title: `Setup ${name}` }, "action");
    const gen = this.generation;
    const live = () => gen === this.generation && this.terms.get(t.id) === t;
    [`$ /bin/sh ${script}\r\n`, `Setting up ${name}...\r\n`, "Done.\r\n"].forEach((line, i) => {
      setTimeout(() => {
        if (live()) this.output(t, line);
      }, 300 * (i + 1));
    });
    setTimeout(() => {
      if (live()) this.kill(t.id, 0);
    }, 1200);
    return { id: t.id, cwd: t.cwd, labels: t.labels };
  }

  private shellOwner(ctx: UiContext | undefined, cwd: string): { labels: Record<string, string>; cwd: string } {
    const s = ctx?.activeThreadId ? this.threads.get(ctx.activeThreadId) : undefined;
    if (ctx?.activeThreadId) {
      if (!s) throw new CommandError("notfound", `thread ${ctx.activeThreadId} not found`);
      return { labels: shellLabels(s.id, s.projectId, s.worktreePath), cwd: cwd || s.worktreePath };
    }
    const exact = ctx?.activeProjectId ? this.projects.get(ctx.activeProjectId)?.worktrees.find((w) => w.path === ctx.activeWorktreePath) : undefined;
    if (exact && ctx) return { labels: shellLabels("", ctx.activeProjectId, exact.path), cwd: cwd || exact.path };
    const path = cwd || ctx?.activeWorktreePath || "";
    let best: { projectId: string; path: string } | null = null;
    for (const project of this.projects.values()) {
      for (const w of project.worktrees) {
        if ((path === w.path || path.startsWith(`${w.path}/`)) && w.path.length > (best?.path.length ?? 0)) best = { projectId: project.id, path: w.path };
      }
    }
    if (!best) throw new CommandError("invalid", `${path} is not inside a registered project`);
    return { labels: shellLabels("", best.projectId, best.path), cwd: cwd || best.path };
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
    this.ember.endAll();
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
    if (args.like) return this.newLikeThread(args.like, args);
    if (args.workspace || args.projects) return this.newWorkspaceThread(args);
    // Like the daemon: from a thread (its CLI, or a page it shows) with no placement, where that thread runs.
    const caller = !args.project && !args.worktree && ctx?.activeView === "" && ctx.activeThreadId ? this.threads.get(ctx.activeThreadId) : undefined;
    if (caller && !caller.projectId) return this.newHomeThread(undefined, args);
    const project = this.projects.get(args.project || ctx?.activeProjectId || caller?.projectId || "") ?? this.worktreeOf(ctx)?.project;
    if (!project) throw new CommandError("invalid", "a worktree or project is required");
    const first = firstMessageOf(args);
    const prompt = args.prompt ?? "";
    const permission = args.permission ?? "";
    if (permission && !(permission in permissionModes)) throw new CommandError("invalid", `permission must be supervised, accept-edits or auto`);
    for (const p of (args.attachments ?? "").split(",").filter(Boolean)) {
      if (!this.attachments.has(p)) throw new CommandError("invalid", `attachment ${p} was not staged`);
    }
    const lineage = this.createdByArgs(args);
    const slug = promptSlug(prompt);
    const gen = this.generation;
    const settle = async (ms: number) => {
      await sleep(ms);
      if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while thread.new ran");
    };
    let path = args.worktree ?? caller?.worktreePath ?? "";
    let baseRef = "";
    const created = args["new-worktree"] === "true";
    if (created) requireGit(project, "a new worktree");
    if (created) {
      baseRef = args.base || (project.remotes.length > 0 ? `origin/${project.defaultBranch}` : project.defaultBranch);
      await settle(this.worktreeDelayMs);
      if (prompt.includes("FAIL")) {
        throw new CommandError("unavailable", project.remotes.length > 0 ? `create worktree: git fetch origin ${baseRef.replace(/^origin\//, "")}: exit status 128` : `create worktree: git worktree add: invalid reference: ${baseRef}`);
      }
      // An existing branch (thread new --branch) reuses its worktree, like the daemon.
      const branch = args.branch || `cf/${slug || `s-new-${String(this.nextId)}`}`;
      path = (args.branch ? project.worktrees.find((w) => !w.isMain && w.branch === args.branch)?.path : undefined) ?? this.addWorktree(project, branch, baseRef).path;
    } else {
      path ||= project.worktrees.find((w) => w.isMain)?.path ?? project.path;
      if (!project.worktrees.some((w) => w.path === path)) throw new CommandError("invalid", `worktree ${path} is not in ${project.name}`);
      await settle(150);
      if (prompt.includes("FAIL")) throw new CommandError("unavailable", "start claude: exec: \"claude\": executable file not found in $PATH");
    }
    const model = args.model || "claude-opus-4-8[1m]";
    const s = this.createThread(project.id, path, model, args.effort ?? "", {
      name: args.name ?? "",
      autoNamed: !args.name,
      // Named in the background a moment after it starts (1–2 ticks), like the daemon.
      nameIn: args.name ? 0 : 2,
      pendingName: promptTitle(prompt) || `thread-${String(this.nextId)}`,
      permissionMode: permissionModes[permission] ?? PermissionMode.UNSPECIFIED,
      baseRef,
      createdWorktree: created,
      firstMessage: first,
      ...lineage,
    });
    // Like the daemon's WorktreeCreated: the project's on-worktree-create actions, in the background.
    if (created) this.actions.worktreeCreated(s.id, project.id, path);
    // Like the daemon: every new thread is focused (unless focus=false); the GUI skips a hidden one (stores/intents.ts).
    if (args.focus !== "false") this.focusThread(s.id);
    const where = lineage.inSidebar === null || lineage.inSidebar === undefined ? "" : `; ${lineage.inSidebar ? "shown in" : "hidden from"} the sidebar`;
    return { message: `created thread ${s.id} in ${path}${where}`, resultJson: JSON.stringify({ id: s.id, worktreePath: path }) };
  }

  /**
   * thread.new's created-by and sidebar, like the daemon: a creator that exists (its name
   * recorded), and sidebar only with one (InvalidArgument otherwise). Empty without them.
   */
  private createdByArgs(args: Record<string, string>): Partial<Pick<MockThread, "createdBy" | "createdByName" | "inSidebar">> {
    const by = (args["created-by"] ?? "").trim();
    const sidebar = args.sidebar ?? "";
    if (!by) {
      if (sidebar) throw new CommandError("invalid", "only applies to a thread another thread creates (created-by, which defaults to $CODE_FOUNDRY_THREAD inside a thread); a thread you create is always shown");
      return {};
    }
    const creator = this.threads.get(by);
    if (!creator) throw new CommandError("invalid", `created-by: no thread ${by}`);
    return { createdBy: creator.id, createdByName: creator.name || creator.id, inSidebar: sidebar ? sidebar === "true" : null };
  }

  /**
   * thread.new --no-project like the daemon: a thread with no project or workspace in the
   * home directory. Refuses any arg that places it, a project or worktree from the caller's
   * context included.
   */
  private async newHomeThread(ctx: UiContext | undefined, args: Record<string, string>): Promise<InvokeOut> {
    for (const name of ["project", "worktree", "workspace", "projects", "new-worktree", "base"]) {
      if (args[name]) throw new CommandError("invalid", `no-project starts a thread without a project; it does not take ${name}`);
    }
    if (ctx?.activeProjectId) throw new CommandError("invalid", "no-project starts a thread without a project; it does not take project");
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
    if (args.focus !== "false") this.focusThread(s.id);
    return { message: `created thread ${s.id} in ${HOME} (no project)`, resultJson: JSON.stringify({ id: s.id, worktreePath: HOME }) };
  }

  /**
   * thread.new with `workspace` or `projects` like the daemon (workspaces v2): the set is
   * `projects` (refs, ":base" ignored), else the workspace's members; the primary is
   * `project` ("workspace": the workspace's folder), else the workspace's default primary,
   * else the first project. With new-worktree every git project gets a worktree on the new
   * branch (`branch`, else cf/<slug>); otherwise each runs in its own checkout.
   */
  private async newWorkspaceThread(args: Record<string, string>): Promise<InvokeOut> {
    const created = args["new-worktree"] === "true";
    const prompt = args.prompt ?? "";
    const permission = args.permission ?? "";
    const first = firstMessageOf(args);
    for (const p of (args.attachments ?? "").split(",").filter(Boolean)) {
      if (!this.attachments.has(p)) throw new CommandError("invalid", `attachment ${p} was not staged`);
    }
    const gen = this.generation;
    const settle = async (ms: number) => {
      await sleep(ms);
      if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while thread.new ran");
    };
    const ws = args.workspace ? this.workspaceRef(args.workspace) : undefined;
    const refs = (args.projects ?? "").split(",").map((r) => r.trim().split(":")[0] ?? "").filter(Boolean);
    const ids = refs.length > 0 ? [...new Set(refs.map((r) => this.projectRef(r).id))] : [...(ws?.members ?? [])];
    let primary = args.project ? (args.project === "workspace" ? "workspace" : this.projectRef(args.project).id) : ws && (ws.defaultPrimary === "workspace" || ids.includes(ws.defaultPrimary)) ? ws.defaultPrimary : (ids[0] ?? "");
    if (!primary && ws) primary = "workspace";
    if (primary === "workspace" && !ws) throw new CommandError("invalid", "project workspace needs a workspace");
    if (primary !== "workspace" && !ids.includes(primary)) ids.push(primary);
    await settle(created ? this.worktreeDelayMs : 150);
    if (prompt.includes("FAIL")) throw new CommandError("unavailable", "start claude: exec: \"claude\": executable file not found in $PATH");
    const slug = promptSlug(prompt);
    const branch = created ? args.branch || `cf/${slug || `s-new-${String(this.nextId)}`}` : "";
    let cwd = ws && primary === "workspace" ? this.workspaceDirOf(ws) : "";
    for (const id of ids) {
      const r = this.projectRef(id);
      const path = !created || r.git === false ? this.mainPathOf(id) : (r.worktrees.find((w) => w.branch === branch)?.path ?? this.addWorktree(r, branch, r.remotes.length > 0 ? `origin/${r.defaultBranch}` : r.defaultBranch).path);
      if (id === primary) cwd = path;
    }
    const s = this.createThread(primary === "workspace" ? "" : primary, cwd, args.model || "claude-opus-4-8[1m]", args.effort ?? "", {
      name: args.name ?? "",
      autoNamed: !args.name,
      nameIn: args.name ? 0 : 2,
      pendingName: promptTitle(prompt) || `thread-${String(this.nextId)}`,
      permissionMode: permissionModes[permission] ?? PermissionMode.UNSPECIFIED,
      createdWorktree: created,
      branch,
      projectIds: [...ids].sort(),
      workspaceId: ws?.id ?? "",
      firstMessage: first,
    });
    if (args.focus !== "false") this.focusThread(s.id);
    const warnings = this.hintsFor(s);
    return {
      message: `created thread ${s.id} in ${cwd}${ws ? ` (workspace ${ws.name})` : ""}`,
      resultJson: JSON.stringify({ id: s.id, worktreePath: cwd, workspaceId: ws?.id ?? "" }),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** A thread's set as the hints read it (mock/projectSets.ts). */
  private setThread(s: MockThread): SetThread {
    return { id: s.id, name: s.name, projectId: s.projectId, projectIds: this.projectIdsOf(s), worktreePath: s.worktreePath, createdWorktree: s.createdWorktree, branch: s.branch, archivedAt: s.archivedAt };
  }

  /** The daemon's collision hints for a thread just made (CreateThreadResponse.hints). */
  private hintsFor(s: MockThread): string[] {
    return createHints(this.setThread(s), [...this.threads.values()].map((t) => this.setThread(t)), this.projects.values());
  }

  /**
   * Test control: a connected, idle thread over a project set, made at once: `projects`
   * (refs), `project` the primary (default the first; `workspace`: the workspace's folder),
   * `workspace` a reference, `branch` (worktree mode: a worktree on it in every git project,
   * reused when there is one; "": each project's own checkout). POST /__mock/set-thread.
   */
  addSetThread(o: { projects: string[]; project: string; workspace: string; branch: string; name: string }): MockThread {
    const ws = o.workspace ? this.workspaceRef(o.workspace) : undefined;
    const set = o.projects.map((r) => this.projectRef(r).id);
    const inFolder = o.project === "workspace";
    const primary = inFolder ? "" : o.project ? this.projectRef(o.project).id : (set[0] ?? "");
    const pathOf = (id: string): string => {
      const p = this.projectRef(id);
      if (!o.branch || p.git === false) return this.mainPathOf(id);
      return p.worktrees.find((w) => w.branch === o.branch)?.path ?? this.addWorktree(p, o.branch, p.remotes.length > 0 ? `origin/${p.defaultBranch}` : p.defaultBranch).path;
    };
    const paths = set.map(pathOf);
    const path = inFolder && ws ? this.workspaceDirOf(ws) : (paths[set.indexOf(primary)] ?? "");
    const s = this.addThread({
      id: `s-set-${String(this.nextId++)}`,
      projectId: primary,
      worktreePath: path,
      name: o.name,
      model: "claude-4.5-haiku[1m]",
      effort: "",
      workspaceId: ws?.id ?? "",
      projectIds: set,
      createdWorktree: o.branch !== "",
      branch: o.branch,
      createdAt: new Date(),
    });
    this.publishThread(s);
    return s;
  }

  /** thread.workspace: the reference set or cleared (""); a thread in its workspace's folder keeps it. */
  setThreadWorkspace(s: MockThread, ref: string): string {
    const label = s.name ? `${s.name} (${s.id})` : s.id;
    const id = ref.trim() ? this.workspaceRef(ref.trim()).id : "";
    if (id === s.workspaceId) return `thread ${label} ${id ? `references workspace ${id}` : "references no workspace"}`;
    if (!s.projectId && s.workspaceId) throw new CommandError("unavailable", `thread ${label} runs in its workspace's folder; its workspace cannot change`);
    s.workspaceId = id;
    this.publishThread(s);
    return `thread ${label} ${id ? `now references workspace ${id}` : "references no workspace"}; it applies from the thread's next start`;
  }

  /**
   * thread.new-like (and thread.new --like): the source thread's set, branch, primary,
   * workspace reference and mode; `project` picks another primary of the set (or
   * `workspace`). A worktree-mode member whose worktree is gone gets it again.
   */
  private async newLikeThread(srcId: string, args: Record<string, string>): Promise<InvokeOut> {
    const src = this.threads.get(srcId);
    if (!src) throw new CommandError("notfound", `thread ${srcId} not found`);
    const set = this.projectIdsOf(src);
    const ws = src.workspaceId ? this.workspaces.get(src.workspaceId) : undefined;
    const inFolder = args.project === "workspace" || (!args.project && !src.projectId && ws !== undefined);
    if (inFolder && !ws) throw new CommandError("invalid", `thread ${src.id} has no workspace to run in`);
    const primary = inFolder ? "" : args.project ? this.projectRef(args.project).id : src.projectId;
    if (!inFolder && !set.includes(primary)) throw new CommandError("invalid", `project ${primary} is not one of thread ${src.id}'s projects (${set.join(", ")})`);
    const prompt = args.prompt ?? "";
    const permission = args.permission ?? "";
    const gen = this.generation;
    await sleep(150);
    if (gen !== this.generation) throw new CommandError("unavailable", "mock reset while thread.new ran");
    if (prompt.includes("FAIL")) throw new CommandError("unavailable", 'start claude: exec: "claude": executable file not found in $PATH');
    const worktreeMode = src.createdWorktree && src.branch !== "";
    const placeOf = (): string => {
      if (inFolder && ws) return this.workspaceDirOf(ws);
      if (primary === src.projectId) return src.worktreePath;
      const p = this.projectRef(primary);
      return worktreeMode && p.git !== false ? (p.worktrees.find((w) => w.branch === src.branch)?.path ?? this.addWorktree(p, src.branch, src.baseRef || p.defaultBranch).path) : this.mainPathOf(primary);
    };
    const path = placeOf();
    const s = this.createThread(primary, path, args.model || src.model || "claude-opus-4-8[1m]", args.effort ?? "", {
      name: args.name ?? "",
      autoNamed: !args.name,
      nameIn: args.name ? 0 : 2,
      pendingName: promptTitle(prompt) || `thread-${String(this.nextId)}`,
      permissionMode: permissionModes[permission] ?? PermissionMode.UNSPECIFIED,
      baseRef: src.baseRef,
      createdWorktree: worktreeMode,
      branch: worktreeMode ? src.branch : "",
      projectIds: set,
      workspaceId: src.workspaceId,
      firstMessage: firstMessageOf(args),
    });
    if (args.focus !== "false") this.focusThread(s.id);
    const warnings = this.hintsFor(s);
    return { message: `created thread ${s.id} in ${path}`, resultJson: JSON.stringify({ id: s.id, worktreePath: path, projectIds: this.projectIdsOf(s) }), ...(warnings.length > 0 ? { warnings } : {}) };
  }


  /**
   * ThreadService.StageAttachment: keeps the bytes' size, the page hint and a PDF's bytes,
   * returns a fake path; a PDF's carries the count like the daemon's (the hint, else "~1").
   */
  stageAttachment(name: string, mimeType: string, data: Uint8Array, pages = 0): string {
    const size = data.length;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(mimeType)) throw new CommandError("invalid", `unsupported attachment type ${mimeType}`);
    const max = mimeType === "application/pdf" ? 20 : 10;
    if (size > max * 1024 * 1024) throw new CommandError("invalid", `attachment larger than ${String(max)} MiB`);
    const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? "").toLowerCase();
    const count = mimeType === "application/pdf" ? `-${pages > 0 ? String(pages) : "~1"}p` : "";
    const path = `${HOME}/.code-foundry/attachments/att-${String(this.attachments.size + 1)}${count}${ext}`;
    this.attachments.set(path, { name, mimeType, size, pages });
    if (mimeType === "application/pdf") this.attachmentBytes.set(path, data.slice());
    return path;
  }

  /**
   * ThreadService.StageAttachment with a path: the mock has no files, so the type comes
   * from the extension (the daemon sniffs the content) and the bytes are empty. Errors
   * like the daemon: relative is invalid, anything but the five types is invalid with
   * the daemon's unsupported-type message.
   */
  stageAttachmentPath(path: string, pages = 0): string {
    if (!path.startsWith("/")) throw new CommandError("invalid", `attachment path "${path}" is not absolute`);
    const ext = (/\.[a-z0-9]+$/i.exec(path)?.[0] ?? "").toLowerCase();
    const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
    const mimeType = types[ext];
    if (!mimeType) throw new CommandError("invalid", `attachment type "text/plain; charset=utf-8" (want image/png, image/jpeg, image/gif, image/webp or application/pdf)`);
    return this.stageAttachment(path.slice(path.lastIndexOf("/") + 1), mimeType, new Uint8Array(), pages);
  }

  /**
   * ProjectService.ListRefs: local branches, then remote-tracking refs; the branch names
   * (local and origin's merged; the mock has no commit dates, so the default branch first,
   * then by name); the default branch, and the default ref naming it ("origin/<default>"
   * only when there is no local one).
   */
  listRefs(projectId: string): { refs: string[]; defaultRef: string; branches: string[]; defaultBranch: string } {
    const project = this.projects.get(projectId);
    if (!project) throw new CommandError("notfound", `project ${projectId} not found`);
    requireGit(project, "listing refs");
    const local = [...new Set([...project.worktrees.map((w) => w.branch), ...(project.branches ?? [])].filter(Boolean))].sort();
    const remote = !project.remotes.includes("origin") ? [] : project.githubSlug ? ["origin/main", "origin/release/v0.3", "origin/feat/sidebar"].sort() : [`origin/${project.defaultBranch}`];
    const def = project.defaultBranch;
    const names = [...new Set([...local, ...remote.map((r) => r.slice("origin/".length))])].sort();
    const branches = names.includes(def) ? [def, ...names.filter((n) => n !== def)] : names;
    const defaultRef = !local.includes(def) && remote.includes(`origin/${def}`) ? `origin/${def}` : def;
    return { refs: [...local, ...remote], defaultRef, branches, defaultBranch: def };
  }

  /** Test control: the worktree at `path` checks out `branch` ("" detaches HEAD). False when there is no such worktree. */
  checkout(path: string, branch: string): boolean {
    for (const project of this.projects.values()) {
      const w = project.worktrees.find((x) => x.path === path);
      if (!w) continue;
      w.branch = branch;
      w.detached = branch === "";
      this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
      return true;
    }
    return false;
  }

  /** Test control: the worktree at `path` has `modified` modified files (0: clean). POST /__mock/worktree/dirty. */
  setDirty(path: string, modified: number): boolean {
    for (const project of this.projects.values()) {
      const w = project.worktrees.find((x) => x.path === path);
      if (!w) continue;
      w.status = { ...w.status, modified, dirty: modified > 0 || w.status.staged > 0 || w.status.untracked > 0 };
      this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
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
    for (const project of this.projects.values()) {
      const w = project.worktrees.find((x) => x.path === path);
      if (!w) continue;
      w.status = op
        ? { ...w.status, operation: op, operationStep: step, operationTotal: total, conflicted, dirty: w.status.dirty || conflicted > 0 }
        : { ...w.status, operation: "", operationStep: 0, operationTotal: 0, conflicted: 0 };
      const names = op ? Array.from({ length: conflicted }, (_, i) => files[i] ?? `conflict_${String(i + 1)}.go`) : [];
      this.gh.setConflicts(path, names);
      this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
      return true;
    }
    return false;
  }

  // ---- Project API -----------------------------------------------------------------

  worktreeMsg(projectId: string, w: MockWorktree): WorktreeInit {
    return { projectId, path: w.path, branch: w.branch, head: w.head, detached: w.detached ?? false, isMain: w.isMain, mergedClean: mergedClean(w), status: { ...w.status, refreshedAt: timestampFromDate(new Date()) } };
  }

  projectMsg(r: MockProject): ProjectInit {
    return { id: r.id, path: r.path, name: r.name, defaultBranch: r.defaultBranch, githubSlug: r.githubSlug, remotes: r.remotes, git: r.git !== false, worktrees: r.worktrees.map((w) => this.worktreeMsg(r.id, w)) };
  }

  /**
   * ProjectService.Register (the Add Project dialog's Local folder tab and an existing clone
   * destination), with the daemon's rules: "~" expands, the path must be absolute and
   * under home, a folder inside a git repository adds that repository, any other folder
   * a project without git, and an already registered project is returned unchanged.
   */
  /** A typed path as the daemon's handlers take it: "~" expanded, absolute, cleaned, under home. */
  private homePath(raw: string): string {
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
    return path;
  }

  /** ProjectService.InspectFolder: is the folder (inside) a repository, else its child repositories. */
  inspectFolder(raw: string): { path: string; isRepo: boolean; childRepos: { path: string; name: string }[] } {
    const path = this.homePath(raw);
    const info = folderInfo(path);
    if (!info) throw new CommandError("invalid", `invalid argument: ${path}: no such file or directory`);
    return info;
  }

  /**
   * project.add-workspace: every child repository becomes a project (registered ones are
   * reused), then a rooted workspace named after the folder ("<name> 2" when taken) with
   * "workspace" as its default primary. Test control: a child named "broken" fails.
   */
  addFolderWorkspace(raw: string): MockWorkspace {
    const info = this.inspectFolder(raw);
    const hint = `add it as a project (code-foundry project add ${info.path})`;
    if (info.isRepo) throw new CommandError("unavailable", `${info.path} is a git repository: ${hint}`);
    if (info.childRepos.length === 0) throw new CommandError("unavailable", `no git repositories directly inside ${info.path}: ${hint}`);
    const ids: string[] = [];
    for (const c of info.childRepos) {
      if (c.name === "broken") throw new CommandError("invalid", `could not add 1 of ${String(info.childRepos.length)} repositories in ${info.path} (broken: permission denied); no workspace was made`);
      const id = this.registerFolder(c.path).id;
      if (!ids.includes(id)) ids.push(id);
    }
    const base = info.path.split("/").pop() || "Workspace";
    const taken = (n: string) => n.toLowerCase() === "workspace" || [...this.workspaces.values()].some((w) => w.name.toLowerCase() === n.toLowerCase());
    let name = base;
    for (let i = 2; taken(name); i++) name = `${base} ${String(i)}`;
    const w: MockWorkspace = {
      id: `w-${String(this.workspaces.size + 1).padStart(12, "0")}`,
      name,
      members: [...ids].sort(),
      rootPath: info.path,
      defaultPrimary: "workspace",
      // The mock's folders hold no files: a real root's CLAUDE.md and skills show once linked.
      instructions: "",
      skills: [],
      createdAt: new Date(),
    };
    this.workspaces.set(w.id, w);
    this.workspaceEvents.publish({ event: { case: "updated", value: this.workspaceMsg(w) } });
    return w;
  }

  registerFolder(raw: string): MockProject {
    const path = this.homePath(raw);
    const registered = (p: string) =>
      [...this.projects.values()].find((r) => r.path === p || p.startsWith(`${r.path}/`) || r.worktrees.some((w) => w.path === p || p.startsWith(`${w.path}/`)));
    const known = registered(path);
    if (known) return known;
    const folder = projectFolder(path) ?? (cloneExists(path) ? { path, git: true } : undefined);
    if (!folder) throw new CommandError("invalid", `invalid argument: ${path}: no such file or directory`);
    const again = registered(folder.path);
    if (again) return again;
    const name = folder.path.split("/").pop() || folder.path;
    let id = `repo-${name.toLowerCase()}`;
    for (let n = 2; this.projects.has(id); n++) id = `repo-${name.toLowerCase()}-${String(n)}`;
    const project: MockProject = folder.git
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
    this.projects.set(id, project);
    this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(project) } });
    return project;
  }

  /** ProjectService.Clone's last step: a cloned GitHub repository registered at path. */
  addClone(owner: string, name: string, path: string): MockProject {
    let id = `repo-${name.toLowerCase()}`;
    for (let n = 2; this.projects.has(id); n++) id = `repo-${name.toLowerCase()}-${String(n)}`;
    const project: MockProject = {
      id,
      path,
      name,
      defaultBranch: "main",
      githubSlug: `${owner}/${name}`,
      remotes: ["origin"],
      worktrees: [{ path, branch: "main", head: "c1013ed0", isMain: true, status: clean() }],
    };
    this.projects.set(id, project);
    this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(project) } });
    return project;
  }

  /**
   * ProjectService.InitGit and project.git.init: a project without git becomes a git repository
   * on main (the empty "Initial commit"), its folder the main worktree on that branch.
   */
  initGit(id: string): MockProject {
    const project = this.projects.get(id);
    if (!project) throw new CommandError("notfound", `project ${id} not found`);
    if (project.git !== false) throw new CommandError("unavailable", `${project.name} is already a git repository`);
    project.git = true;
    project.defaultBranch = "main";
    project.worktrees = project.worktrees.map((w) => (w.isMain ? { ...w, branch: "main", head: "1a1t1a10", status: clean({ upstream: "", baseRef: "", untracked: 3, dirty: true }) } : w));
    this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(project) } });
    return project;
  }

  // ---- New projects and publishing (mock/create.ts) --------------------------------

  /** Every project's folder (project.create refuses a taken one). */
  projectPaths(): string[] {
    return [...this.projects.values()].map((r) => r.path);
  }

  projectInfo(id: string): { name: string; path: string; git: boolean; remotes: string[] } | undefined {
    const r = this.projects.get(id);
    return r && { name: r.name, path: r.path, git: r.git !== false, remotes: r.remotes };
  }

  /** Test control: a project's name (the daemon takes it from the folder; e.g. "workspace", the primary keyword). POST /__mock/project/rename. */
  renameProject(id: string, name: string): MockProject {
    const r = this.projectRef(id);
    r.name = name;
    this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(r) } });
    return r;
  }

  /** ProjectService.Delete (and project.unregister): the project is gone. */
  removeProject(id: string): void {
    this.actions.removeProject(id);
    this.projects.delete(id);
    this.projectEvents.publish({ event: { case: "projectRemovedId", value: id } });
  }

  /** ProjectService.Create: a git project on main with its empty first commit, no remote. */
  addCreated(name: string, path: string): { id: string; name: string; path: string } {
    let id = `repo-${name.toLowerCase()}`;
    for (let n = 2; this.projects.has(id); n++) id = `repo-${name.toLowerCase()}-${String(n)}`;
    const project: MockProject = {
      id,
      path,
      name,
      defaultBranch: "main",
      githubSlug: "",
      remotes: [],
      worktrees: [{ path, branch: "main", head: "1n1t1a10", isMain: true, status: clean({ upstream: "", baseRef: "" }) }],
    };
    this.projects.set(id, project);
    this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(project) } });
    return { id, name, path };
  }

  /** ProjectService.Publish succeeded: origin on GitHub, main tracking origin/main. */
  setOrigin(id: string, slug: string): void {
    const project = this.projects.get(id);
    if (!project) return;
    project.remotes = ["origin"];
    project.githubSlug = slug;
    project.worktrees = project.worktrees.map((w) => (w.isMain ? { ...w, status: { ...w.status, upstream: "origin/main", baseRef: "origin/main" } } : w));
    this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(project) } });
  }

  // ---- Commands -----------------------------------------------------------------

  private worktreeOf(ctx: UiContext | undefined): { project: MockProject; wt: MockWorktree } | null {
    if (!ctx?.activeWorktreePath) return null;
    for (const project of this.projects.values()) {
      const wt = project.worktrees.find((w) => w.path === ctx.activeWorktreePath);
      if (wt) return { project, wt };
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
        const clones = [...this.projects.values()].filter((r) => r.githubSlug !== "" && r.githubSlug.toLowerCase() === slug.toLowerCase());
        const find = (pred: (w: MockWorktree) => boolean): { projectId: string; path: string } | null => {
          for (const r of clones) {
            const w = r.worktrees.find(pred);
            if (w) return { projectId: r.id, path: w.path };
          }
          return null;
        };
        let target: { projectId: string; path: string } | null = null;
        if (args.worktree) {
          const owner = [...this.projects.values()].find((r) => r.worktrees.some((w) => w.path === args.worktree));
          target = { projectId: owner?.id ?? "", path: args.worktree };
        } else {
          const first = clones[0];
          if (!first) throw new CommandError("unavailable", `no registered project is a clone of ${slug}: add one with \`code-foundry project add <folder>\`, or pass --worktree`);
          const active = ctx?.activeWorktreePath;
          if (!fix && active) target = find((w) => w.path === active);
          if (!target) target = find(onHead);
          if (!target && !fix) target = { projectId: first.id, path: first.worktrees.find((w) => w.isMain)?.path ?? first.path };
          if (!target) {
            if (!head) throw new CommandError("unavailable", `#${String(n)} has no head branch to check out: pass --worktree`);
            if (cross) throw new CommandError("unavailable", `#${String(n)} comes from a fork and no worktree of ${slug} has its head checked out: check it out (for example \`gh pr checkout ${String(n)}\` in a worktree) and pass --worktree`);
            // The daemon fetches origin/<head> and creates the branch tracking it.
            const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${first.githubSlug}/${head.replace(/\//g, "-")}`, branch: head, head: pr?.headSha ?? "c0ffee00", isMain: false, status: clean({ upstream: `origin/${head}`, baseRef: "" }) };
            first.worktrees.push(w);
            this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(first.id, w) } });
            target = { projectId: first.id, path: w.path };
          }
        }
        const defaults = this.threadDefaults();
        const s = this.createThread(target.projectId, target.path, args.model ?? defaults.model, args.effort ?? defaults.effort);
        this.focusThread(s.id);
        // Like the daemon: the result JSON is the created Thread (protojson).
        return {
          message: `Started thread ${s.id} for PR #${String(n)}`,
          resultJson: JSON.stringify({ id: s.id, projectId: s.projectId, worktreePath: s.worktreePath, model: s.model, effort: s.effort }),
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
      ...bridgeCommands(() => [...this.threads.values()]),
      ...this.logs.commands(),
      ...mcpCommands(this.logs, (i) => this.emit(i)),
      ...panelItemCommands((id) => {
        const t = this.threads.get(id);
        return t ? { projectId: t.projectId, worktreePath: t.worktreePath, githubSlug: this.projects.get(t.projectId)?.githubSlug ?? "" } : undefined;
      }, (i) => this.emit(i)),
      ...agentsCommands(this.logs, (i) => this.emit(i)),
      ...this.actions.commands(),
      ...this.plugins.commands(),
      ...this.skills.commands(),
      ...this.memory.commands(),
      ...this.themes.commands(),
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
            { name: "project", type: ArgType.STRING, required: false, description: "Project id" },
            { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree path" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name the thread belongs to" },
            { name: "projects", type: ArgType.STRING, required: false, description: "Comma-separated projects it works in (project:base with new-worktree); it runs in the first unless project" },
            { name: "like", type: ArgType.STRING, required: false, description: "Thread to copy projects, branch and mode from" },
            { name: "model", type: ArgType.ENUM, required: false, description: "Model", enumValues: MODEL_VALUES, defaultValue: "claude-opus-4-8[1m]" },
            { name: "effort", type: ArgType.ENUM, required: false, description: "Effort", enumValues: ["low", "medium", "high", "xhigh", "max"], defaultValue: "high" },
            { name: "permission", type: ArgType.ENUM, required: false, description: "Permission mode", enumValues: ["supervised", "accept-edits", "auto"] },
            { name: "new-worktree", type: ArgType.BOOL, required: false, description: "Create a worktree for the thread" },
            { name: "no-project", type: ArgType.BOOL, required: false, description: "Start the thread without a project, in the home directory" },
            { name: "base", type: ArgType.STRING, required: false, description: "Base ref for the new worktree" },
            { name: "branch", type: ArgType.STRING, required: false, description: "The new worktree's branch; an existing one is checked out" },
            { name: "name", type: ArgType.STRING, required: false, description: "Thread name" },
            { name: "prompt", type: ArgType.STRING, required: false, description: "First prompt" },
            { name: "attachments", type: ArgType.STRING, required: false, description: "Staged attachment paths, comma-separated" },
            { name: "composer-prompt", type: ArgType.STRING, required: false, description: "The composer's text of prompt with its tag tokens" },
            { name: "created-by", type: ArgType.STRING, required: false, description: "The thread whose agent creates this one (default: $CODE_FOUNDRY_THREAD)", defaultToThreadEnv: true },
            {
              name: "sidebar",
              type: ArgType.BOOL,
              required: false,
              description:
                "With created-by: show the new thread in the sidebar (or with false, hide it) whatever settings threads.show_created_threads says; a thread another thread creates is hidden by default and archived with its creator",
            },
            { name: "focus", type: ArgType.BOOL, required: false, description: "Select the new thread in every window (--focus=false: no window moves)", defaultValue: "true" },
          ],
        },
        // Like the daemon: also in the composer, whose no-project target has no project, and from a thread's CLI or page.
        when: (ctx) =>
          this.worktreeOf(ctx) !== null || Boolean(ctx?.activeProjectId && this.projects.has(ctx.activeProjectId)) || ctx?.activeView === "compose" || (ctx?.activeView === "" && activeThread(ctx) !== undefined),
        run: (ctx, args) => this.newThread(ctx, args),
      },
      {
        cmd: { name: "thread.fork", title: "Fork Thread", category: "Thread", description: "Start a new thread that continues this one's conversation", keybindings: [], args: [{ name: "name", type: ArgType.STRING, required: false, description: "Name for the fork" }] },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          const f = this.createThread(s.projectId, s.worktreePath, s.model, s.effort, { pendingName: `${s.name || s.id} (fork)`, permissionMode: s.permissionMode, parentId: s.id });
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
          description: "Move a thread to another of its checkouts (or its workspace's folder).",
          keybindings: [],
          args: [
            { name: "project", type: ArgType.STRING, required: false, description: "A project of the thread's set (id or name), or workspace" },
            { name: "worktree", type: ArgType.PATH, required: false, description: "A checkout's path" },
          ],
        },
        // Like the daemon (runElsewhere): in the GUI only for a thread with somewhere else to run; from the CLI any, Run refuses one with a single checkout.
        when: (ctx) => {
          const s = activeThread(ctx);
          // Two or more places among its projects and its workspace's folder (src/lib/threadRow canRunElsewhere).
          return s !== undefined && (!ctx?.activeView || this.projectIdsOf(s).length + (s.workspaceId ? 1 : 0) > 1);
        },
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          if (!args.project && !args.worktree) throw new CommandError("invalid", "name the member: a project or a worktree path");
          const out = this.runIn(s, args.project ?? "", args.worktree ?? "");
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
          name: "thread.unsubscribe",
          title: "Unsubscribe Thread from Wakes",
          category: "Thread",
          description: "Remove a wake subscription by id, or every subscription of a thread (default: the thread this runs in) to a target.",
          keybindings: [],
          args: [{ name: "subscription", type: ArgType.STRING, required: false, description: "Subscription id (sub-…)" }],
        },
        when: always,
        // The mock keeps only Ember's timers (mock/ember.ts): the Board's × cancels one by id.
        run: (_ctx, args) => {
          const id = args.subscription ?? "";
          if (!id) throw new CommandError("invalid", "give a subscription id");
          if (!this.ember.removeTimer(id)) throw new CommandError("notfound", `subscription ${id} not found`);
          return `removed ${id}`;
        },
      },
      {
        cmd: {
          name: "workspace.new",
          title: "New Workspace",
          category: "Workspace",
          description: "Save a set of projects as a workspace, with a folder of its own for the instructions and skills that span them. Nothing else is created.",
          keybindings: [],
          args: [
            { name: "name", type: ArgType.STRING, required: true, description: "Workspace name" },
            { name: "projects", type: ArgType.STRING, required: false, description: "Comma-separated projects (id, name, or absolute path)" },
            { name: "root", type: ArgType.PATH, required: false, description: "A folder the workspace comes from" },
            { name: "primary", type: ArgType.STRING, required: false, description: "Where new threads start: a project, or workspace" },
          ],
        },
        when: always,
        run: (_ctx, args) => {
          const ws = this.addWorkspace(args.name ?? "", (args.projects ?? "").split(",").map((r) => r.trim()).filter(Boolean), { root: args.root ?? "", primary: args.primary ?? "" });
          return Promise.resolve({ message: `created workspace ${ws.name} (${ws.id})`, resultJson: JSON.stringify({ id: ws.id, name: ws.name, members: ws.members, defaultPrimary: ws.defaultPrimary }) });
        },
      },
      {
        cmd: {
          name: "thread.workspace",
          title: "Set Thread Workspace",
          category: "Thread",
          description: "Set the workspace a thread references (its instructions and skills), or clear it; it applies from the thread's next start.",
          keybindings: [],
          args: [
            { name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name; empty clears the reference" },
          ],
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const s = this.thread(args.id || (ctx?.activeThreadId ?? ""));
          return this.setThreadWorkspace(s, args.workspace ?? "");
        },
      },
      {
        cmd: {
          name: "thread.new-like",
          title: "New thread on this branch",
          category: "Thread",
          description: "Start a new thread with this thread's projects, branch, primary, workspace and mode (thread new --like); only the prompt is new.",
          keybindings: [],
          args: [
            { name: "id", type: ArgType.STRING, required: false, description: "The thread to copy (default: the active thread)" },
            { name: "project", type: ArgType.STRING, required: false, description: "Where it runs: one of the thread's projects, or workspace" },
            { name: "model", type: ArgType.ENUM, required: false, description: "Model", enumValues: MODEL_VALUES },
            { name: "effort", type: ArgType.ENUM, required: false, description: "Effort", enumValues: ["low", "medium", "high", "xhigh", "max"] },
            { name: "permission", type: ArgType.ENUM, required: false, description: "Permission mode", enumValues: ["supervised", "accept-edits", "auto"] },
            { name: "prompt", type: ArgType.STRING, required: false, description: "First prompt" },
            { name: "attachments", type: ArgType.STRING, required: false, description: "Staged attachment paths, comma-separated" },
            { name: "composer-prompt", type: ArgType.STRING, required: false, description: "The composer's text of prompt with its tag tokens" },
            { name: "name", type: ArgType.STRING, required: false, description: "Thread name" },
            { name: "focus", type: ArgType.BOOL, required: false, description: "Select the new thread in every window", defaultValue: "true" },
          ],
        },
        // Like the daemon (canNewLike): in the GUI only for a thread with a project or a workspace.
        when: (ctx) => activeThread(ctx) !== undefined && (!ctx?.activeView || Boolean(ctx.activeProjectId || ctx.activeWorkspaceId)),
        run: (ctx, args) => this.newLikeThread(args.id || (ctx?.activeThreadId ?? ""), args),
      },
      {
        cmd: {
          name: "workspace.rename",
          title: "Rename Workspace",
          category: "Workspace",
          description: "Rename a workspace (names are unique, whatever their case).",
          keybindings: [],
          args: [
            { name: "name", type: ArgType.STRING, required: true, description: "New name" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name (default: the active workspace)" },
          ],
        },
        when: always,
        run: (ctx, args) => `renamed workspace ${this.renameWorkspace(args.workspace || ctx?.activeWorkspaceId || "", args.name ?? "").name}`,
      },
      {
        cmd: {
          name: "workspace.set-primary",
          title: "Set Workspace Default Primary",
          category: "Workspace",
          description: "Set where new threads in a workspace start: one of its projects, or workspace (its folder).",
          keybindings: [],
          args: [
            { name: "primary", type: ArgType.STRING, required: true, description: "A project of the workspace (id or name), or workspace" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name (default: the active workspace)" },
          ],
        },
        when: always,
        run: (ctx, args) => {
          const ws = this.setWorkspacePrimary(args.workspace || ctx?.activeWorkspaceId || "", args.primary ?? "");
          return `workspace ${ws.name} starts in ${ws.defaultPrimary}`;
        },
      },
      {
        cmd: {
          name: "workspace.add-project",
          title: "Add Project to Workspace",
          category: "Workspace",
          description: "Add a project to a workspace. Nothing on disk changes.",
          keybindings: [],
          args: [
            { name: "project", type: ArgType.STRING, required: true, description: "Project id, name, or absolute path" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name (default: the active workspace)" },
          ],
        },
        when: always,
        run: (ctx, args) => {
          const ws = this.addWorkspaceProject(args.workspace || ctx?.activeWorkspaceId || "", args.project ?? "");
          return `added ${args.project ?? ""} to workspace ${ws.name} (${String(ws.members.length)} projects)`;
        },
      },
      {
        cmd: {
          name: "workspace.remove-project",
          title: "Remove Project from Workspace",
          category: "Workspace",
          description: "Drop a project from a workspace. Nothing on disk changes; threads keep their projects.",
          keybindings: [],
          args: [
            { name: "project", type: ArgType.STRING, required: true, description: "Project id or name" },
            { name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name (default: the active workspace)" },
          ],
        },
        when: always,
        run: (ctx, args) => {
          const ws = this.removeWorkspaceProject(args.workspace || ctx?.activeWorkspaceId || "", args.project ?? "");
          return `removed ${args.project ?? ""} from workspace ${ws.name} (${String(ws.members.length)} left)`;
        },
      },
      {
        cmd: {
          name: "workspace.remove",
          title: "Remove Workspace",
          category: "Workspace",
          description: "Forget a workspace. Its folder goes with its instructions and skills; for a workspace with a root, only the links. Projects, worktrees and threads stay.",
          keybindings: [],
          args: [{ name: "workspace", type: ArgType.STRING, required: true, description: "Workspace id or name" }],
          // Like the daemon's DynamicConfirm: what goes depends on the kind.
          confirm: (_ctx, args) => {
            const ws = [...this.workspaces.values()].find((w) => w.id === args.workspace || w.name.toLowerCase() === (args.workspace ?? "").toLowerCase());
            if (ws?.rootPath) return `Remove workspace ${ws.name}? Its root folder ${ws.rootPath} and everything in it stay; only the workspace and its links go.`;
            return `Remove workspace ${ws?.name ?? args.workspace ?? ""}? Its instructions and skills are deleted too.`;
          },
        },
        when: always,
        run: (_ctx, args) => {
          this.removeWorkspace(args.workspace ?? "");
          return `removed workspace ${args.workspace ?? ""}`;
        },
      },
      {
        cmd: {
          name: "workspace.reveal",
          title: "Reveal Workspace in Finder",
          category: "Workspace",
          description: "Show a workspace's folder in Finder: its root when it has one, else its own folder.",
          keybindings: [],
          args: [{ name: "workspace", type: ArgType.STRING, required: false, description: "Workspace id or name (default: the active workspace)" }],
        },
        when: (ctx) => Boolean(ctx?.activeWorkspaceId || !ctx?.activeView || ctx.activeView === "projects"),
        run: (ctx, args) => `revealed ${this.workspaceDirOf(this.workspaceRef(args.workspace || ctx?.activeWorkspaceId || ""))}`,
      },
      {
        cmd: {
          name: "thread.flag.clear",
          title: "Clear Thread Flags",
          category: "Thread",
          description: "Remove the flags plugins raised on a thread: one plugin's with --plugin, else every one.",
          keybindings: [],
          args: [
            { name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" },
            { name: "plugin", type: ArgType.STRING, required: false, description: "Only this plugin's flag" },
          ],
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const id = args.id || (ctx?.activeThreadId ?? "");
          const n = this.clearFlags(id, args.plugin ?? "");
          return `cleared ${String(n)} ${n === 1 ? "flag" : "flags"} on thread ${id}`;
        },
      },
      {
        cmd: {
          name: "thread.restart",
          title: "Restart Claude",
          category: "Thread",
          description:
            "Restart a thread's Claude process with the same conversation, so it picks up what changed outside it, such as a plugin's environment. A running turn is interrupted; background agents and shells stop. A thread whose Claude is not running is left as it is: its next message starts Claude afresh.",
          keybindings: [],
          args: [{ name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" }],
          // Like the daemon: only a restart that cuts something off asks.
          confirmIf: (ctx, args) => {
            const s = args.id ? this.threads.get(args.id) : activeThread(ctx);
            return s !== undefined && this.interrupts(s).why !== "";
          },
          confirm: (ctx, args) => {
            const s = args.id ? this.threads.get(args.id) : activeThread(ctx);
            const { why, ends } = s ? this.interrupts(s) : { why: "", ends: "" };
            const q = `Restart Claude for ${s?.name || (s?.id ?? "")}? The conversation continues`;
            return ends === "ends the turn" ? `${q}; the current turn is interrupted.` : `${q}, but ${why}; restarting ${ends}.`;
          },
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const id = args.id || (ctx?.activeThreadId ?? "");
          const s = this.thread(id);
          if (!this.restartThread(id)) return `Claude is not running for thread ${s.name || id} (${id}); its next message starts it with the current environment`;
          return `restarting Claude for thread ${s.name || id} (${id}); the conversation continues`;
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
          // Like the daemon: only archiving a thread that is mid-turn or running background
          // work asks, or one that takes a working hidden child along (archiveOneConfirm).
          confirmIf: (ctx, args) => {
            const s = activeThread(ctx);
            return s !== undefined && archiving(s, args) && (this.interrupts(s).why !== "" || this.hiddenWorking(s.id).length > 0);
          },
          confirm: (ctx) => {
            const s = activeThread(ctx);
            const name = s?.name || (s?.id ?? "");
            const { why, ends } = s ? this.interrupts(s) : { why: "", ends: "" };
            const kids = s ? this.hiddenWorking(s.id).length : 0;
            const parts = [why ? `${why}; archiving ${ends}.` : "", kids > 0 ? hiddenWorkingText(kids, name) : ""].filter(Boolean);
            return `Archive thread ${name}? ${parts.join(" ")}`;
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
          name: "thread.sidebar",
          title: "Show or Hide Thread in Sidebar",
          category: "Thread",
          description:
            "Show a thread another thread created in the sidebar, handing it to the user, or hide it again, handing it back to its creator (whatever settings threads.show_created_threads says). A hidden thread is archived with its creator; a shown one is not.",
          keybindings: [],
          args: [{ name: "shown", type: ArgType.BOOL, required: true, description: "Show (true) or hide (false) the thread in the sidebar" }],
        },
        when: (ctx) => activeThread(ctx) !== undefined,
        run: (ctx, args) => {
          const s = activeThread(ctx);
          if (!s) throw new CommandError("unavailable", "no active thread");
          if (args.shown !== "true" && args.shown !== "false") throw new CommandError("invalid", "shown is required: true or false");
          return this.setThreadSidebar(s.id, args.shown === "true");
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
          // Like the daemon's DynamicConfirm: a thread in a worktree Code Foundry made says its clean worktrees go.
          confirm: (ctx) => {
            const s = activeThread(ctx);
            const made = s?.createdWorktree === true && s.branch !== "" ? " Its clean worktrees are removed; branches stay." : "";
            return `Remove thread ${ctx?.activeThreadId ?? ""}? Claude stops if it runs, and the thread is forgotten.${made}`;
          },
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
          name: "project.add",
          title: "Add Project",
          category: "Project",
          description: "Add a project: start a new one, add a folder on this Mac, or clone a repository from GitHub. Opens the Add Project dialog in the app.",
          keybindings: [],
          args: [{ name: "path", type: ArgType.PATH, required: false, description: "Project folder to add without the dialog (a git repository or any folder under home)" }],
        },
        when: always,
        // The GUI presents it (the dialog); this is the CLI's answer, like the daemon.
        run: (_ctx, args) => {
          if (!args.path) return "Add a project from the CLI with `code-foundry project add <folder>` or `code-foundry project clone <owner/repo>`; in the app, project.add opens the Add Project dialog.";
          const project = this.registerFolder(args.path);
          return Promise.resolve({ message: `registered ${project.name} (${project.id})`, resultJson: JSON.stringify(this.projectMsg(project)) });
        },
      },
      {
        cmd: {
          name: "project.add-workspace",
          title: "Add Folder as Workspace",
          category: "Project",
          description: "Add a folder of git repositories: every repository directly inside it becomes a project, and a workspace named after the folder holds them, with the folder as its root.",
          keybindings: [],
          args: [{ name: "folder", type: ArgType.PATH, required: true, description: "A folder under home whose immediate subfolders are git repositories" }],
        },
        when: always,
        run: (_ctx, args) => {
          const w = this.addFolderWorkspace(args.folder ?? "");
          const json = { id: w.id, name: w.name, rootPath: w.rootPath, members: [...w.members].sort(), defaultPrimary: w.defaultPrimary };
          return Promise.resolve({ message: `created workspace ${w.name} (${w.id})`, resultJson: JSON.stringify(json) });
        },
      },
      {
        cmd: {
          name: "project.clone",
          title: "Clone from GitHub",
          category: "Project",
          description: "Clone a github.com repository with `gh repo clone` into ~/.code-foundry/projects/<owner>/<repo> and add it as a project.",
          keybindings: [],
          args: [{ name: "repo", type: ArgType.STRING, required: true, description: "owner/repo or https://github.com/owner/repo" }],
        },
        when: always,
        run: () => {
          throw new CommandError("unavailable", "the mock clones through ProjectService.Clone (the Add Project dialog)");
        },
      },
      {
        cmd: {
          name: "project.unregister", title: "Remove Project", category: "Project", description: "Stop tracking the active project", keybindings: [], args: [],
          confirm: (ctx) => `Stop tracking project ${ctx?.activeProjectId ?? ""}? Its threads lose their worktree; clean worktrees Code Foundry made that no thread uses are removed (branches stay).`,
        },
        when: (ctx) => Boolean(ctx?.activeProjectId && this.projects.has(ctx.activeProjectId)),
        run: (ctx) => {
          const id = ctx?.activeProjectId ?? "";
          this.projects.delete(id);
          this.projectEvents.publish({ event: { case: "projectRemovedId", value: id } });
          return `Unregistered ${id}`;
        },
      },
      {
        cmd: {
          name: "project.git.init",
          title: "Initialize Git",
          category: "Project",
          description: "Make a project without git a git repository: git init on the default branch (init.defaultBranch, else main) and an empty initial commit, so worktrees can branch from it.",
          keybindings: [],
          args: [{ name: "project", type: ArgType.STRING, required: false, description: "Project id (default: the active project)" }],
        },
        // Like the daemon: a project is active and it is not a git repository.
        when: (ctx) => this.projects.get(ctx?.activeProjectId ?? "")?.git === false,
        run: (ctx, args) => {
          const project = this.initGit(args.project || ctx?.activeProjectId || "");
          return `initialized git in ${project.name} on ${project.defaultBranch}`;
        },
      },
      {
        cmd: {
          name: "project.refresh", title: "Refresh Git Status", category: "Project", description: "Reconcile git status now", keybindings: [],
          args: [{ name: "project", type: ArgType.STRING, required: false, description: "Project id (default: all)" }],
        },
        when: always,
        run: (_ctx, args) => {
          for (const r of this.projects.values()) if (!args.project || args.project === r.id) this.projectEvents.publish({ event: { case: "projectUpdated", value: this.projectMsg(r) } });
          return args.project ? `refreshed ${args.project}` : "Git status refreshed";
        },
      },
      {
        // As internal/command/commands_project.go: project (context), branch (prompted), base, fetch.
        cmd: {
          name: "project.worktree.new",
          title: "New Worktree",
          category: "Project",
          description: "Create a worktree for a branch, creating the branch from base when it does not exist.",
          keybindings: [],
          args: [
            { name: "project", type: ArgType.STRING, required: false, description: "Project id (default: the active project)" },
            { name: "branch", type: ArgType.STRING, required: true, description: "Branch to check out" },
            { name: "base", type: ArgType.STRING, required: false, description: "Ref to branch from (default: the default branch)" },
            { name: "fetch", type: ArgType.BOOL, required: false, description: "Fetch the remote base branch first", defaultValue: "true" },
          ],
        },
        when: (ctx) => this.projects.get(ctx?.activeProjectId ?? "")?.git !== false && Boolean(ctx?.activeProjectId && this.projects.has(ctx.activeProjectId)),
        run: (ctx, args) => {
          const project = this.projects.get(args.project || ctx?.activeProjectId || "");
          if (!project) throw new CommandError("unavailable", "no active project");
          requireGit(project, "a new worktree");
          const branch = args.branch ?? "";
          const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${project.githubSlug || `_local/${project.name}`}/${branch.replace(/\//g, "-")}`, branch, head: "c0ffee00", isMain: false, status: clean({ upstream: "", baseRef: "" }) };
          project.worktrees.push(w);
          this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
          return `created worktree ${w.path} on ${branch}`;
        },
      },
      {
        cmd: {
          name: "worktree.create",
          title: "Create Worktree",
          category: "Worktree",
          description: "New worktree for a branch in the active project",
          keybindings: [],
          args: [
            { name: "branch", type: ArgType.STRING, required: true, description: "Branch name" },
            { name: "base_ref", type: ArgType.STRING, required: false, description: "Base ref" },
          ],
        },
        when: (ctx) => this.projects.get(ctx?.activeProjectId ?? "")?.git !== false && Boolean(ctx?.activeProjectId && this.projects.has(ctx.activeProjectId)),
        run: (ctx, args) => {
          const project = this.projects.get(ctx?.activeProjectId ?? "");
          if (!project) throw new CommandError("unavailable", "no active project");
          requireGit(project, "a new worktree");
          const branch = args.branch ?? "";
          const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${project.githubSlug || `_local/${project.name}`}/${branch.replace(/\//g, "-")}`, branch, head: "c0ffee00", isMain: false, status: clean({ upstream: "", baseRef: "" }) };
          project.worktrees.push(w);
          this.projectEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(project.id, w) } });
          this.intents.publish({ intent: { case: "focusProject", value: { projectId: project.id, worktreePath: w.path } } });
          return `Created worktree ${branch}`;
        },
      },
      {
        cmd: {
          name: "project.worktree.remove", title: "Remove Worktree", category: "Worktree", description: "Remove the active worktree", keybindings: [],
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
        // As internal/command/commands_project_cleanup.go (the fetch is not modelled).
        cmd: {
          name: "project.worktree.cleanup",
          title: "Clean Up Merged Worktrees",
          category: "Project",
          description: "Fetch, then remove the project's worktrees (or one) whose work is already in origin/<default>. Branches are kept.",
          keybindings: [],
          args: [
            { name: "project", type: ArgType.STRING, required: true, description: "Project name or id" },
            { name: "path", type: ArgType.PATH, required: false, description: "One worktree (default: every merged one)" },
          ],
          confirm: (ctx, args) => {
            const ref = args.project || ctx?.activeProjectId || "";
            const { removed: rm, skipped: sk } = this.cleanupWorktrees(ref, args.path ?? "", true);
            const line = (w: MockWorktree, reason: string) => `\n- ${w.branch} at ${w.path}: ${reason}`;
            const r0 = rm[0];
            const s0 = sk[0];
            if (args.path && r0) return `Remove the worktree of ${r0.branch} at ${r0.path} (${removedReason(r0)})? The branch is kept. It is checked again after a fetch.`;
            if (args.path && s0) return `Fetch and check the worktree of ${s0.w.branch} at ${s0.w.path} again? Right now it is kept: ${s0.reason}.`;
            if (rm.length + sk.length === 0) return `Fetch ${ref} and remove the worktrees Code Foundry made whose work is already in the default branch? Branches are kept.`;
            let msg =
              rm.length === 0
                ? "Fetch and remove the worktrees Code Foundry made whose work is in the default branch? None would be removed now; each is checked again after the fetch."
                : `Fetch, then remove ${String(rm.length)} ${rm.length === 1 ? "worktree" : "worktrees"} (branches are kept; each is checked again after the fetch):` +
                  rm.map((w) => line(w, removedReason(w))).join("");
            if (sk.length > 0) msg += `\nKeep ${String(sk.length)}:` + sk.map((s) => line(s.w, s.reason)).join("");
            return msg;
          },
        },
        when: (ctx) => Boolean(ctx?.activeProjectId && this.projects.get(ctx.activeProjectId)?.git !== false),
        run: (ctx, args) => {
          const res = this.cleanupWorktrees(args.project || ctx?.activeProjectId || "", args.path ?? "", false);
          const parts: string[] = [];
          const n = (k: number) => `${String(k)} ${k === 1 ? "worktree" : "worktrees"}`;
          if (res.removed.length > 0) parts.push(`Removed ${n(res.removed.length)}: ${res.removed.map((w) => `${w.branch} (${removedReason(w)})`).join(", ")}`);
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
        for (const project of this.projects.values()) {
          const wt = project.worktrees.find((w) => w.path === path);
          if (wt) return { projectId: project.id, path: wt.path, branch: wt.branch, githubSlug: project.githubSlug, hasRemote: project.remotes.length > 0 };
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
        cmd: { name: "view.panel.toggle", title: "Toggle Side Panel", category: "View", description: "Show or hide the side panel next to the selected thread or page.", keybindings: ["cmd+shift+e"], args: panelThreadArgs },
        when: always,
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.toggle", args),
      },
      {
        cmd: { name: "view.bottom.toggle", title: "Toggle Bottom Panel", category: "View", description: "Show or hide the terminals under the selected thread or page. In the app, opening it with no terminal starts a shell.", keybindings: ["cmd+j"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "bottom.toggle" } } }))}`,
      },
      {
        cmd: { name: "view.panel.expand", title: "Expand Side Panel", category: "View", description: "Toggle the side panel between its split width and the full width of the content area for the selected thread or page.", keybindings: [], args: panelThreadArgs },
        when: always,
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.expand", args),
      },
      {
        cmd: { name: "view.panel.new-tab", title: "New Side Panel Tab", category: "View", description: "Show the surface list in the side panel of the selected thread or page, to open another tab there.", keybindings: [], args: panelThreadArgs },
        when: always,
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.new-tab", args),
      },
      {
        cmd: { name: "view.panel.split", title: "Split Side Panel", category: "View", description: "Split or unsplit the side panel of the selected thread or page into two tab groups.", keybindings: ["cmd+\\"], args: panelThreadArgs },
        when: always,
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.split", args),
      },
      {
        cmd: { name: "view.back", title: "Back", category: "View", description: "Return to the previously selected thread or page.", keybindings: ["cmd+["], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "back" } } }))}`,
      },
      {
        cmd: { name: "view.forward", title: "Forward", category: "View", description: "Go to the thread or page selected before going back.", keybindings: ["cmd+]"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "forward" } } }))}`,
      },
      {
        cmd: { name: "thread.previous", title: "Previous Thread", category: "View", description: "Select the thread above the current one in the sidebar.", keybindings: ["cmd+shift+["], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "thread.previous" } } }))}`,
      },
      {
        cmd: { name: "thread.next", title: "Next Thread", category: "View", description: "Select the thread below the current one in the sidebar.", keybindings: ["cmd+shift+]"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "thread.next" } } }))}`,
      },
      {
        cmd: {
          name: "view.panel.worktree",
          title: "Show Worktree in Side Panel",
          category: "View",
          description: "Open the Worktree surface in the selected thread's side panel: the overview of the worktree it runs in, with sync state, GitHub activity, changed files and log.",
          keybindings: [],
          args: panelThreadArgs,
        },
        // Like the daemon: a thread is active and it sits in a registered worktree.
        when: (ctx) => Boolean(ctx?.activeThreadId && ctx.activeProjectId && ctx.activeWorktreePath),
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.worktree", args),
      },
      {
        cmd: {
          name: "view.panel.linked-prs",
          title: "Show Linked PRs in Side Panel",
          category: "View",
          description: "Open the Linked PRs surface in the selected thread's side panel: the pull requests the thread created or touched, newest first, with state, checks and branch.",
          keybindings: [],
          args: panelThreadArgs,
        },
        // Like the daemon: a thread is active (with or without linked pull requests).
        when: (ctx) => Boolean(ctx?.activeThreadId),
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.linked-prs", args),
      },
      {
        cmd: {
          name: "view.panel.usage",
          title: "Show Usage in Side Panel",
          category: "View",
          description: "Open the Usage surface in the selected thread's side panel: its cost at Claude API rates, tokens and requests, per model and per token kind.",
          keybindings: [],
          args: panelThreadArgs,
        },
        // Like the daemon: a thread is active (with or without usage).
        when: (ctx) => Boolean(ctx?.activeThreadId),
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.usage", args),
      },
      {
        cmd: {
          name: "view.panel.threads",
          title: "Show Related Threads in Side Panel",
          category: "View",
          description: "Open the Threads surface in the selected thread's side panel: the thread whose agent created it, its siblings and the threads created from it, with status, place and brief.",
          keybindings: [],
          args: panelThreadArgs,
        },
        // Like the daemon: a thread is active (with or without lineage).
        when: (ctx) => Boolean(ctx?.activeThreadId),
        run: (_ctx, args) => runPanelVerb((i) => this.emit(i), "panel.threads", args),
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
            .map(
              (s) =>
                `${s} themes:\n` +
                [...this.themes.choices(s).map((t) => ({ ...t, yours: true })), ...themesFor(s).map((t) => ({ id: t.id, name: t.name, yours: false }))]
                  .map((t) => `${t.id === v[`appearance.theme_${s}`] ? "*" : " "} ${t.id}  ${t.name}${t.yours ? "  [yours]" : ""}`)
                  .join("\n"),
            )
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
          args: [{ name: "theme", type: ArgType.ENUM, required: true, description: `A ${scheme} theme id`, enumValues: [...this.themes.choices(scheme).map((t) => t.id), ...themesFor(scheme).map((t) => t.id)] }],
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
      // Like internal/command/commands_theme_ask.go: a no-project thread that makes the theme described.
      {
        cmd: {
          name: "theme.ask",
          title: "Ask the Model for a Theme…",
          category: "Settings",
          description: "Start a thread that makes the colour theme you describe: the model saves and applies it, and the thread shows it as a card with Undo and Edit.",
          keybindings: [],
          args: [
            { name: "description", type: ArgType.STRING, required: false, positional: true, description: "The theme, in your words" },
            { name: "pair", type: ArgType.ENUM, required: false, description: "One of your themes: ask for its pair of the other scheme", enumValues: [...this.themes.choices("dark"), ...this.themes.choices("light")].map((t) => t.id) },
          ],
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          // The first message is the user's words; the daemon puts the context (where they
          // asked, the slots, what to do) in the thread's system prompt, which the mock has not.
          let ask = (args.description ?? "").trim();
          if (args.pair) {
            const t = this.themes.userTheme(args.pair);
            if (!t) throw new CommandError("invalid", `argument "pair": ${JSON.stringify(args.pair)} is not one of your themes`);
            ask = `Make a ${t.scheme === "dark" ? "light" : "dark"} pair for my theme ${t.name}.\n\n${ask}`.trim();
          }
          if (!ask) throw new CommandError("invalid", 'argument "description": describe the theme (or give --pair)');
          return this.newHomeThread(undefined, { prompt: ask, permission: "auto" });
        },
      },
      // Like internal/command/commands_theme_edit.go: the Themes page editing one of the user's themes.
      {
        cmd: {
          name: "theme.edit",
          title: "Edit Theme…",
          category: "Settings",
          description: "Open one of your themes in the Themes page's editor. A curated theme is copied first (theme duplicate <id>).",
          keybindings: [],
          args: [{ name: "theme", type: ArgType.ENUM, required: true, description: "One of your themes' ids (theme list marks them)", enumValues: [...this.themes.choices("dark"), ...this.themes.choices("light")].map((t) => t.id) }],
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          const id = args.theme ?? "";
          if (!this.themes.isUser(id)) throw new CommandError("invalid", `argument "theme": ${JSON.stringify(id)} is not one of your themes`);
          return `delivered=${String(this.emit({ intent: { case: "showView", value: { name: `themes.edit.${id}` } } }))}`;
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
    const startsThread = new Set(["thread.new", "thread.new-like", "pr.ask", "pr.explain", "pr.fix.findings", "theme.ask"]);
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
      .map(({ cmd: { confirm, confirmIf: _if, confirmLabel: _label, ...cmd }, when }) => ({ ...cmd, available: when(ctx), requiresConfirmation: confirm !== undefined }))
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
            activeProjectId: ctx.activeProjectId,
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
    // And a thread command's --id for the context's thread (thread.new-like from the composer).
    if (name.startsWith("thread.") && args.id && this.threads.has(args.id)) whenCtx = { ...whenCtx, activeThreadId: args.id } as UiContext;
    if (!entry.when(whenCtx)) throw new CommandError("unavailable", `${name} is not available here`);
    for (const a of entry.cmd.args) {
      if (a.required && !args[a.name]) throw new CommandError("invalid", `missing required arg ${a.name}`);
    }
    if (entry.cmd.confirm && !confirmed && (entry.cmd.confirmIf?.(ctx, args) ?? true)) throw new ConfirmNeeded(name, entry.cmd.title, entry.cmd.confirm(ctx, args), entry.cmd.confirmLabel);
    return entry.run(ctx, args);
  }
}
