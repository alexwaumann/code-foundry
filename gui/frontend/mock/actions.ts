/**
 * Actions in the mock daemon (docs/notes/actions-1-daemon.md): per-project commands and
 * their runs. ActionService (mock/server.ts), the `action` event source, and the action.*
 * commands. A terminal run is a mock terminal (labels kind=action, see the label contract)
 * whose output plays from a script on timers; a background run keeps its output. Runs
 * finish with their script's exit code, or when their terminal is killed (129), exits
 * (TerminalService.Kill, terminal.close, ^C: 130) or is removed while running (-1). Debug
 * daemon ignores SIGHUP like a real `make dev` child: terminal.kill ends it with SIGKILL
 * (137) after KILL_GRACE_MS, like the daemon's grace period.
 *
 * Seeds (repo-cf only, in order; ids fixed for e2e):
 *   a-dev000000000  Dev           play       pnpm dev          terminal, runs until stopped
 *   a-test00000000  Test          test       go test ./...     terminal, exits 1 after ~2.6 s
 *   a-check0000000  Check         lint       make check        terminal, exits 0 after ~4.1 s
 *   a-build0000000  Build         build      make build        terminal, exits 0 after ~1.5 s
 *   a-install00000  Install deps  configure  pnpm install      terminal, on worktree create, exits 0 after ~1.2 s
 *   a-debug0000000  Debug daemon  debug      make dev          terminal, runs until stopped
 * Any other command prints two lines and exits after ~1.2 s with the code in "exit N"
 * (else 0); one containing "sleep infinity" or the word "dev" runs until stopped.
 * Store refusals read like internal/store/action's: the sentinel first ("failed
 * precondition: this project already has…"), which Connect's rawMessage keeps.
 */
import { create, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ActionIcon,
  ActionPickSource,
  ActionRunMode,
  ActionRunSchema,
  ActionRunState,
  ActionRunTrigger,
  ActionSchema,
  ListActionsResponseSchema,
  type ActionEventSchema,
  type ActionRunRecordSchema,
  type LastActionRunResponseSchema,
} from "../src/gen/codefoundry/v1/action_pb";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";

export type ActionEventInit = MessageInitShape<typeof ActionEventSchema>;
type ActionInit = MessageInitShape<typeof ActionSchema>;
type RunInit = MessageInitShape<typeof ActionRunSchema>;
type RecordInit = MessageInitShape<typeof ActionRunRecordSchema>;
type PickInit = MessageInitShape<typeof LastActionRunResponseSchema>;

/** What the world offers MockActions. */
export interface ActionHost {
  /** Into world.events as EventSource.ACTION. */
  publish(e: ActionEventInit): void;
  /** Registered projects and their worktree paths. */
  projects(): { id: string; name: string; worktrees: string[] }[];
  /** A thread's project ("" for none), worktree and each member's checkout by project id; undefined when unknown. */
  thread(id: string): { projectId: string; worktreePath: string; checkouts: Record<string, string> } | undefined;
  /** Starts a kind=action terminal and returns its id. */
  startTerminal(argv: string[], cwd: string, labels: Record<string, string>): string;
  /** Output to a running terminal (no-op when it is gone or exited). */
  write(terminalId: string, text: string): void;
  /** The terminal's process exits with code (world.kill); the world reports it back with terminalExited. */
  exit(terminalId: string, code: number): void;
}

interface MockAction {
  id: string;
  projectId: string;
  name: string;
  command: string;
  icon: ActionIcon;
  inTerminal: boolean;
  onWorktreeCreate: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A run's persisted record (the daemon's action_runs row), newest first in MockActions.records. */
interface MockRecord {
  runId: string;
  actionId: string;
  projectId: string;
  threadId: string;
  mode: ActionRunMode;
  trigger: ActionRunTrigger;
  startedAt: Date;
}

interface MockRun {
  id: string;
  actionId: string;
  actionName: string;
  command: string;
  projectId: string;
  threadId: string;
  worktreePath: string;
  mode: ActionRunMode;
  terminalId: string;
  state: ActionRunState;
  exitCode: number;
  startedAt: Date;
  finishedAt: Date | null;
  trigger: ActionRunTrigger;
  output: string;
  outputTruncated: boolean;
  timers: ReturnType<typeof setTimeout>[];
  waiters: (() => void)[];
  /** terminal.kill's SIGHUP does not end it; SIGKILL follows after KILL_GRACE_MS. */
  ignoresHangup: boolean;
}

/** Output lines at times (ms after the start), then an exit; exit null runs until stopped. */
interface Script {
  steps: { at: number; text: string }[];
  exit: { at: number; code: number } | null;
  /** terminal.kill's SIGHUP does not end it (SIGKILL, 137, follows after KILL_GRACE_MS). */
  ignoresHangup?: boolean;
}

/** How long terminal.kill waits before SIGKILL for a run that ignores SIGHUP (the daemon's is ~3 s). */
export const KILL_GRACE_MS = 1500;

const RUNS_PER_PROJECT = 50;
const OUTPUT_CAP = 64 * 1024;
const MAX_NAME = 64;

const G = "\x1b[32m";
const R = "\x1b[31m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const C = "\x1b[36m";
const X = "\x1b[0m";
const PKG = "github.com/alexwaumann/code-foundry";

/** Lines `gap` ms apart starting at `from`. */
function lines(from: number, gap: number, text: readonly string[]): Script["steps"] {
  return text.map((t, i) => ({ at: from + i * gap, text: `${t}\n` }));
}

const SCRIPTS: { match: (cmd: string) => boolean; script: (cwd: string) => Script }[] = [
  {
    match: (c) => c.includes("go test"),
    script: () => ({
      steps: [
        ...lines(300, 350, [`${G}ok${X}  \t${PKG}/internal/api\t2.114s`, `${G}ok${X}  \t${PKG}/internal/command\t0.381s`]),
        ...lines(1200, 120, [
          `${R}--- FAIL: TestFingerprintChangesOnForcePush (0.00s)${X}`,
          "    fingerprint_test.go:41: fingerprint unchanged after the head moved",
          "        got:  {CheckCount:3 ReviewState:APPROVED}",
          "        want: a different fingerprint",
          `${R}FAIL${X}`,
          `${R}FAIL${X}\t${PKG}/internal/store/pr\t0.412s`,
        ]),
        ...lines(2300, 200, [`${G}ok${X}  \t${PKG}/internal/store/thread\t1.902s`, `${R}FAIL${X}`]),
      ],
      exit: { at: 2600, code: 1 },
    }),
  },
  {
    match: (c) => c.includes("make check"),
    script: () => ({
      steps: [
        ...lines(200, 500, ["gofmt -l .", "go vet ./...", "staticcheck ./...", "go test ./..."]),
        ...lines(2300, 300, [
          `${G}ok${X}  \t${PKG}/internal/api\t2.114s`,
          `${G}ok${X}  \t${PKG}/internal/command\t0.381s`,
          `${G}ok${X}  \t${PKG}/internal/model\t0.092s`,
          `${G}ok${X}  \t${PKG}/internal/store/pr\t0.412s`,
          `?   \t${PKG}/internal/store/prtest\t[no test files]`,
        ]),
        ...lines(3700, 200, ["cd gui/frontend && pnpm run typecheck && pnpm run lint && pnpm test", ` ${G}Test Files${X}  48 passed (48)`]),
      ],
      exit: { at: 4100, code: 0 },
    }),
  },
  {
    match: (c) => c.includes("make build"),
    script: () => ({
      steps: [
        ...lines(100, 150, [
          "go build -trimpath -o bin/code-foundry ./cmd/code-foundry",
          "cd gui && wails3 task build",
          "task: [build:frontend] pnpm run build",
          `${C}vite v7.1.4${X} ${G}building for production...${X}`,
          `${G}✓${X} 2214 modules transformed.`,
          `${D}dist/${X}index.html                 0.61 kB`,
          `${D}dist/${X}assets/index-Bq3x8Yc1.css   88.40 kB │ gzip: 14.21 kB`,
          `${D}dist/${X}assets/index-C2fWm0aT.js  1,412.73 kB │ gzip: 401.66 kB`,
          `${G}✓ built in 6.12s${X}`,
        ]),
        { at: 1400, text: "task: [build:darwin] go build -o bin/code-foundry-gui .\n" },
      ],
      exit: { at: 1500, code: 0 },
    }),
  },
  {
    match: (c) => c.includes("pnpm install"),
    script: () => ({
      steps: lines(150, 200, [
        "Lockfile is up to date, resolution step is skipped",
        "Packages: +412",
        `${G}++++++++++++++++++++++++++++++++++++++++${X}`,
        "Progress: resolved 412, reused 412, downloaded 0, added 412, done",
        `${B}dependencies:${X} react 19.2.0, zustand 5.0.8, @xterm/xterm 5.5.0`,
        "Done in 1.1s",
      ]),
      exit: { at: 1200, code: 0 },
    }),
  },
  {
    match: (c) => c.includes("make dev"),
    script: () => ({
      steps: lines(200, 300, [
        "go run ./cmd/code-foundry daemon --dev",
        `time=09:14:02.118 level=${G}INFO${X} msg="opened database" path=~/.code-foundry/db.sqlite migrations=19`,
        `time=09:14:02.140 level=${G}INFO${X} msg="daemon listening" addr=127.0.0.1:7788 pid=52169`,
        `time=09:14:02.902 level=${G}INFO${X} msg="gh poll" repos=3 prs=7 took=761ms`,
      ]),
      exit: null,
      ignoresHangup: true,
    }),
  },
  {
    match: (c) => c.includes("pnpm dev"),
    script: (cwd) => ({
      steps: lines(200, 150, [
        "",
        `> code-foundry-gui@0.0.0 dev ${cwd}/gui/frontend`,
        "> vite",
        "",
        `  ${G}${B}VITE${X} ${G}v7.1.4${X}  ${D}ready in${X} ${B}412${X} ms`,
        "",
        `  ${G}➜${X}  ${B}Local${X}:   ${C}http://localhost:5173/${X}`,
        `  ${G}➜${X}  ${D}Network: use ${B}--host${X}${D} to expose${X}`,
      ]),
      exit: null,
    }),
  },
];

/** The script a command plays (see the header). */
export function scriptFor(command: string, cwd: string): Script {
  const known = SCRIPTS.find((s) => s.match(command));
  if (known) return known.script(cwd);
  if (/sleep infinity|\bdev\b/.test(command)) return { steps: lines(150, 0, [`${D}[mock] running until stopped${X}`]), exit: null };
  const code = Number(/exit (\d+)/.exec(command)?.[1] ?? "0");
  return { steps: lines(150, 400, ["[mock] this command has no script", `[mock] exiting with code ${String(code)}`]), exit: { at: 1200, code } };
}

/** A worktree-create run for POST /__mock/action/setup: some output, then `code` after ~600 ms. */
export function setupScript(code: number): Script {
  const fail = [`${R}ERR_PNPM_FETCH_404${X}  GET https://registry.npmjs.org/@codefoundry%2Fnope: Not Found - 404`, "This error happened while installing a direct dependency."];
  return {
    steps: lines(100, 150, ["Lockfile is up to date, resolution step is skipped", "Packages: +412", ...(code === 0 ? ["Done in 0.6s"] : fail)]),
    exit: { at: 600, code },
  };
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const ICONS: readonly { name: string; icon: ActionIcon }[] = [
  { name: "play", icon: ActionIcon.PLAY },
  { name: "test", icon: ActionIcon.TEST },
  { name: "lint", icon: ActionIcon.LINT },
  { name: "configure", icon: ActionIcon.CONFIGURE },
  { name: "build", icon: ActionIcon.BUILD },
  { name: "debug", icon: ActionIcon.DEBUG },
];
const iconName = (i: ActionIcon) => ICONS.find((x) => x.icon === i)?.name ?? "play";

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new CommandError("invalid", "invalid argument: an action needs a name");
  if (Array.from(name).length > MAX_NAME) throw new CommandError("invalid", `invalid argument: an action name has at most ${String(MAX_NAME)} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) throw new CommandError("invalid", "invalid argument: an action name is one line without control characters");
  return name;
}

function cleanCommand(raw: string): string {
  const cmd = raw.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (!cmd.trim()) throw new CommandError("invalid", "invalid argument: an action needs a command");
  if (cmd.includes("\0")) throw new CommandError("invalid", "invalid argument: the command contains a NUL byte");
  return cmd;
}

function checkIcon(icon: ActionIcon): ActionIcon {
  if (icon === ActionIcon.UNSPECIFIED) return ActionIcon.PLAY;
  if (!ICONS.some((x) => x.icon === icon)) throw new CommandError("invalid", `invalid argument: icon ${String(icon)}; want one of ${ICONS.map((x) => x.name).join(", ")}`);
  return icon;
}

const noProject = "actions belong to a project: pass --repo, select a thread or a worktree, or run inside a registered project";

type Command = {
  cmd: {
    name: string;
    title: string;
    category: string;
    description: string;
    keybindings: string[];
    noPalette?: boolean;
    args: { name: string; type: ArgType; required: boolean; description: string; enumValues?: string[]; defaultValue?: string }[];
  };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
};

/** InvokeOut with the command's exit code (InvokeCommandResponse.exit_code). */
type InvokeWithCode = InvokeOut & { exitCode?: number };

/** Space-padded columns, like the CLI's tabwriter. */
function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd((widths[i] ?? 0) + 2))).join("")).join("\n");
}

function recordMsg(r: MockRecord): RecordInit {
  return { runId: r.runId, actionId: r.actionId, projectId: r.projectId, threadId: r.threadId, mode: r.mode, trigger: r.trigger, startedAt: timestampFromDate(r.startedAt) };
}

export class MockActions {
  private actions = new Map<string, MockAction>();
  /** Newest first. */
  private runs: MockRun[] = [];
  /** Every run's record, newest first; unlike runs they survive a reset of the runs. */
  private records: MockRecord[] = [];
  private nextAction = 1;
  private nextRun = 1;
  /** Bumped by reset and restart, so a worktree-create chain from before stops. */
  private generation = 0;

  constructor(private readonly host: ActionHost) {}

  // ---- State --------------------------------------------------------------------

  /** The seeds (repo-cf only); every run is forgotten. Publishes a snapshot. */
  reset(): void {
    this.dropRuns();
    this.actions.clear();
    this.nextAction = 1;
    this.nextRun = 1;
    const at = new Date(Date.now() - 3 * 24 * 3_600_000);
    const seed = (id: string, name: string, icon: ActionIcon, command: string, onWorktreeCreate = false) => {
      const position = this.actions.size;
      this.actions.set(id, { id, projectId: "repo-cf", name, command, icon, inTerminal: true, onWorktreeCreate, position, createdAt: at, updatedAt: at });
    };
    if (this.host.projects().some((r) => r.id === "repo-cf")) {
      seed("a-dev000000000", "Dev", ActionIcon.PLAY, "pnpm dev");
      seed("a-test00000000", "Test", ActionIcon.TEST, "go test ./...");
      seed("a-check0000000", "Check", ActionIcon.LINT, "make check");
      seed("a-build0000000", "Build", ActionIcon.BUILD, "make build");
      seed("a-install00000", "Install deps", ActionIcon.CONFIGURE, "cd gui/frontend\npnpm install --frozen-lockfile", true);
      seed("a-debug0000000", "Debug daemon", ActionIcon.DEBUG, "make dev");
    }
    this.host.publish(this.snapshot());
  }

  /** A daemon restart: runs live in memory only, so they are gone (no events; the streams end). */
  restart(): void {
    this.dropRuns();
  }

  private dropRuns(): void {
    this.generation++;
    for (const r of this.runs) {
      for (const t of r.timers) clearTimeout(t);
      r.timers = [];
    }
    this.runs = [];
  }

  snapshot(): ActionEventInit {
    return { event: { case: "snapshot", value: this.list("") } };
  }

  private sorted(projectId: string): MockAction[] {
    return [...this.actions.values()].filter((a) => !projectId || a.projectId === projectId).sort((a, b) => (a.projectId === b.projectId ? a.position - b.position : a.projectId < b.projectId ? -1 : 1));
  }

  list(projectId: string): { actions: ActionInit[]; runs: RunInit[]; lastRuns: RecordInit[] } {
    const lastRuns = new Map<string, MockRecord>();
    for (const r of this.records) {
      if ((!projectId || r.projectId === projectId) && this.actions.has(r.actionId) && !lastRuns.has(r.actionId)) lastRuns.set(r.actionId, r);
    }
    return {
      actions: this.sorted(projectId).map((a) => this.actionMsg(a)),
      runs: this.runs.filter((r) => !projectId || r.projectId === projectId).map((r) => this.runMsg(r, false)),
      lastRuns: [...lastRuns.values()].map(recordMsg),
    };
  }

  /** ActionService.LastRun, like action.PickAction: the thread's last user run, else the project's, else its first action. */
  lastRun(projectId: string, threadId: string): PickInit {
    if (!projectId) throw new ConnectError("project_id is required", Code.InvalidArgument);
    const actions = this.sorted(projectId);
    const first = actions[0];
    if (!first) return {};
    const mine = this.records.filter((r) => r.projectId === projectId && r.trigger === ActionRunTrigger.USER && this.actions.has(r.actionId));
    const inThread = threadId ? mine.find((r) => r.threadId === threadId) : undefined;
    const last = inThread ?? mine[0];
    const a = last && this.actions.get(last.actionId);
    if (!last || !a) return { source: ActionPickSource.FIRST, action: this.actionMsg(first) };
    return { source: inThread ? ActionPickSource.THREAD : ActionPickSource.PROJECT, action: this.actionMsg(a), last: recordMsg(last) };
  }

  actionMsg(a: MockAction): ActionInit {
    return {
      id: a.id,
      projectId: a.projectId,
      name: a.name,
      command: a.command,
      icon: a.icon,
      inTerminal: a.inTerminal,
      onWorktreeCreate: a.onWorktreeCreate,
      position: a.position,
      createdAt: timestampFromDate(a.createdAt),
      updatedAt: timestampFromDate(a.updatedAt),
    };
  }

  runMsg(r: MockRun, withOutput: boolean): RunInit {
    return {
      id: r.id,
      actionId: r.actionId,
      actionName: r.actionName,
      command: r.command,
      projectId: r.projectId,
      threadId: r.threadId,
      worktreePath: r.worktreePath,
      mode: r.mode,
      terminalId: r.terminalId,
      state: r.state,
      exitCode: r.exitCode,
      startedAt: timestampFromDate(r.startedAt),
      finishedAt: r.finishedAt ? timestampFromDate(r.finishedAt) : undefined,
      trigger: r.trigger,
      output: withOutput ? r.output : "",
      outputTruncated: withOutput && r.outputTruncated,
    };
  }

  /** GET /__mock/actions: plain JSON. */
  json(): { actions: Record<string, unknown>[]; runs: Record<string, unknown>[] } {
    return {
      actions: this.sorted("").map((a) => ({ ...a, icon: iconName(a.icon), createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString() })),
      runs: this.runs.map((r) => ({
        id: r.id,
        actionId: r.actionId,
        actionName: r.actionName,
        command: r.command,
        projectId: r.projectId,
        threadId: r.threadId,
        worktreePath: r.worktreePath,
        mode: ActionRunMode[r.mode],
        terminalId: r.terminalId,
        state: ActionRunState[r.state],
        exitCode: r.exitCode,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        trigger: ActionRunTrigger[r.trigger],
        output: r.output,
      })),
    };
  }

  // ---- Actions ------------------------------------------------------------------

  private action(id: string): MockAction {
    const a = this.actions.get(id);
    if (!a) throw new CommandError("notfound", `not found: action "${id}"`);
    return a;
  }

  private checkUnique(projectId: string, name: string, self = ""): void {
    const lower = name.toLowerCase();
    const dup = [...this.actions.values()].find((a) => a.projectId === projectId && a.id !== self && a.name.toLowerCase() === lower);
    if (dup) throw new CommandError("unavailable", `failed precondition: this project already has an action named "${dup.name}"`);
  }

  create(req: { projectId: string; name: string; command: string; icon: ActionIcon; inTerminal: boolean; onWorktreeCreate: boolean }): ActionInit {
    if (!this.host.projects().some((r) => r.id === req.projectId)) throw new CommandError("notfound", `not found: project "${req.projectId}" is not registered`);
    const name = cleanName(req.name);
    const command = cleanCommand(req.command);
    const icon = checkIcon(req.icon);
    this.checkUnique(req.projectId, name);
    const now = new Date();
    const id = `a-${(this.nextAction++).toString(16).padStart(12, "0")}`;
    const a: MockAction = { id, projectId: req.projectId, name, command, icon, inTerminal: req.inTerminal, onWorktreeCreate: req.onWorktreeCreate, position: this.sorted(req.projectId).length, createdAt: now, updatedAt: now };
    this.actions.set(id, a);
    this.host.publish({ event: { case: "updated", value: this.actionMsg(a) } });
    return this.actionMsg(a);
  }

  update(req: { id: string; name?: string; command?: string; icon?: ActionIcon; inTerminal?: boolean; onWorktreeCreate?: boolean; position?: number }): ActionInit {
    const a = this.action(req.id);
    const name = req.name === undefined ? a.name : cleanName(req.name);
    const command = req.command === undefined ? a.command : cleanCommand(req.command);
    if (req.icon === ActionIcon.UNSPECIFIED) throw new CommandError("invalid", "icon: unspecified");
    const icon = req.icon === undefined ? a.icon : checkIcon(req.icon);
    this.checkUnique(a.projectId, name, a.id);
    Object.assign(a, { name, command, icon, inTerminal: req.inTerminal ?? a.inTerminal, onWorktreeCreate: req.onWorktreeCreate ?? a.onWorktreeCreate, updatedAt: new Date() });
    const moved = new Set<MockAction>([a]);
    if (req.position !== undefined) {
      const list = this.sorted(a.projectId).filter((x) => x !== a);
      list.splice(Math.max(0, Math.min(req.position, list.length)), 0, a);
      for (const [i, x] of list.entries()) {
        if (x.position !== i) moved.add(x);
        x.position = i;
      }
    }
    for (const x of this.sorted(a.projectId)) if (moved.has(x)) this.host.publish({ event: { case: "updated", value: this.actionMsg(x) } });
    return this.actionMsg(a);
  }

  delete(id: string): void {
    const a = this.action(id);
    this.actions.delete(id);
    this.host.publish({ event: { case: "removedId", value: id } });
    for (const [i, x] of this.sorted(a.projectId).entries()) {
      if (x.position === i) continue;
      x.position = i;
      this.host.publish({ event: { case: "updated", value: this.actionMsg(x) } });
    }
  }

  /** A project was unregistered: its actions and runs go (background runs are stopped first). */
  removeProject(projectId: string): void {
    this.stopBackground((r) => r.projectId === projectId);
    for (const a of this.sorted(projectId)) {
      this.actions.delete(a.id);
      this.host.publish({ event: { case: "removedId", value: a.id } });
    }
    for (const r of this.runs.filter((x) => x.projectId === projectId)) this.forget(r);
  }

  // ---- Runs ---------------------------------------------------------------------

  private run_(id: string): MockRun {
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new CommandError("notfound", `not found: run "${id}"`);
    return r;
  }

  getRun(id: string): RunInit {
    return this.runMsg(this.run_(id), true);
  }

  /** Resolves with the run (and its output) once it has finished; the signal stops waiting, not the run. */
  async waitRun(id: string, signal?: AbortSignal): Promise<RunInit> {
    const r = this.run_(id);
    if (r.state === ActionRunState.RUNNING) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(new ConnectError("wait cancelled", Code.Canceled));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        r.waiters.push(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    return this.runMsg(r, true);
  }

  /**
   * ActionService.Run: an action by id, else by name in the owner's project (or projectId's).
   * A thread runs an action of any project of its set in its checkout of that project
   * (the daemon's action/thread_run.go): a name in the cwd's project first, then in one other member.
   */
  run(
    req: { action: string; threadId?: string; worktreePath?: string; projectId?: string; mode?: ActionRunMode },
    trigger = ActionRunTrigger.USER,
    script?: Script,
  ): RunInit {
    const ref = req.action.trim();
    if (req.threadId) {
      const { a, owner } = this.threadRun(req.threadId, req.projectId ?? "", ref);
      const mode = req.mode === ActionRunMode.TERMINAL || req.mode === ActionRunMode.BACKGROUND ? req.mode : a.inTerminal ? ActionRunMode.TERMINAL : ActionRunMode.BACKGROUND;
      return this.runMsg(this.start(a, owner, mode, trigger, script ?? scriptFor(a.command, owner.worktree)), true);
    }
    const owner = this.owner("", req.worktreePath ?? "", req.projectId ?? "");
    let a = this.actions.get(ref);
    if (a && a.projectId !== owner.projectId) throw new CommandError("unavailable", `action ${a.name} (${a.id}) belongs to another project`);
    a ??= this.sorted(req.projectId || owner.projectId).find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!a) throw new CommandError("notfound", `no action "${ref}" in this project`);
    const mode = req.mode === ActionRunMode.TERMINAL || req.mode === ActionRunMode.BACKGROUND ? req.mode : a.inTerminal ? ActionRunMode.TERMINAL : ActionRunMode.BACKGROUND;
    return this.runMsg(this.start(a, owner, mode, trigger, script ?? scriptFor(a.command, owner.worktree)), true);
  }

  private threadRun(threadId: string, projectId: string, ref: string): { a: MockAction; owner: { threadId: string; projectId: string; worktree: string } } {
    const s = this.host.thread(threadId);
    if (!s) throw new CommandError("notfound", `not found: thread ${threadId}`);
    const members: Record<string, string> = { ...s.checkouts };
    if (s.projectId) members[s.projectId] = s.worktreePath;
    const ids = Object.keys(members).sort();
    if (ids.length === 0) throw new CommandError("unavailable", `failed precondition: thread ${threadId} has no project; actions belong to a project`);
    if (projectId && !ids.includes(projectId)) throw new CommandError("invalid", `invalid argument: project ${projectId} is not one of thread ${threadId}'s projects (${ids.join(", ")})`);
    const named = (pid: string) => this.sorted(pid).filter((x) => x.name.toLowerCase() === ref.toLowerCase());
    let a = this.actions.get(ref);
    if (a && !ids.includes(a.projectId)) throw new CommandError("unavailable", `failed precondition: action ${a.name} (${a.id}) belongs to project ${a.projectId}, which is not one of thread ${threadId}'s projects`);
    if (!a && projectId) a = named(projectId)[0];
    if (!a && !projectId) {
      a = s.projectId ? named(s.projectId)[0] : undefined;
      if (!a) {
        const found = ids.filter((pid) => pid !== s.projectId).flatMap(named);
        if (found.length > 1) throw new CommandError("invalid", `invalid argument: action "${ref}" is in several of thread ${threadId}'s projects; pass its id`);
        a = found[0];
      }
    }
    if (!a) throw new CommandError("notfound", `no action "${ref}" in thread ${threadId}'s projects`);
    return { a, owner: { threadId, projectId: a.projectId, worktree: members[a.projectId] ?? s.worktreePath } };
  }

  private owner(threadId: string, worktree: string, projectId: string): { threadId: string; projectId: string; worktree: string } {
    if (threadId) {
      const s = this.host.thread(threadId);
      if (!s) throw new CommandError("notfound", `not found: thread ${threadId}`);
      if (!s.projectId) throw new CommandError("unavailable", `failed precondition: thread ${threadId} has no project; actions belong to a project`);
      if (projectId && projectId !== s.projectId) throw new CommandError("invalid", `invalid argument: thread ${threadId} is in project ${s.projectId}, not ${projectId}`);
      return { threadId, projectId: s.projectId, worktree: s.worktreePath };
    }
    if (worktree) {
      const project = this.host.projects().find((r) => r.worktrees.includes(worktree));
      if (!project) throw new CommandError("invalid", `invalid argument: ${worktree} is not a worktree of a registered project`);
      return { threadId: "", projectId: project.id, worktree };
    }
    throw new CommandError("invalid", "invalid argument: a run needs a thread or a worktree");
  }

  private start(a: MockAction, owner: { threadId: string; projectId: string; worktree: string }, mode: ActionRunMode, trigger: ActionRunTrigger, script: Script): MockRun {
    const r: MockRun = {
      id: `r-${(this.nextRun++).toString(16).padStart(12, "0")}`,
      actionId: a.id,
      actionName: a.name,
      command: a.command,
      projectId: owner.projectId,
      threadId: owner.threadId,
      worktreePath: owner.worktree,
      mode,
      terminalId: "",
      state: ActionRunState.RUNNING,
      exitCode: 0,
      startedAt: new Date(),
      finishedAt: null,
      trigger,
      output: "",
      outputTruncated: false,
      timers: [],
      waiters: [],
      ignoresHangup: script.ignoresHangup === true,
    };
    this.runs.unshift(r);
    this.records.unshift({ runId: r.id, actionId: r.actionId, projectId: r.projectId, threadId: r.threadId, mode: r.mode, trigger: r.trigger, startedAt: r.startedAt });
    if (mode === ActionRunMode.TERMINAL) {
      const labels: Record<string, string> = { kind: "action", project: owner.projectId, worktree: owner.worktree, action: a.id, "action.name": a.name, "action.run": r.id };
      if (owner.threadId) labels.thread = owner.threadId;
      r.terminalId = this.host.startTerminal(["/bin/zsh", "-lc", a.command], owner.worktree, labels);
    }
    this.host.publish({ event: { case: "runUpdated", value: this.runMsg(r, false) } });
    this.trim(r.projectId);
    for (const step of script.steps) r.timers.push(
        setTimeout(() => {
          this.emit(r, step.text);
        }, step.at),
      );
    const exit = script.exit;
    if (exit) r.timers.push(
        setTimeout(() => {
          this.exitProcess(r, exit.code);
        }, exit.at),
      );
    return r;
  }

  private emit(r: MockRun, text: string): void {
    if (r.state !== ActionRunState.RUNNING) return;
    if (r.mode === ActionRunMode.TERMINAL) {
      this.host.write(r.terminalId, text.replace(/\n/g, "\r\n"));
      return;
    }
    r.output += stripAnsi(text);
    if (r.output.length > OUTPUT_CAP) {
      r.output = r.output.slice(r.output.length - OUTPUT_CAP);
      r.outputTruncated = true;
    }
  }

  /** The run's process exits now: a terminal run through its terminal (which reports back), a background run at once. */
  private exitProcess(r: MockRun, code: number): void {
    if (r.state !== ActionRunState.RUNNING) return;
    if (r.mode === ActionRunMode.TERMINAL) this.host.exit(r.terminalId, code);
    // The terminal reported it (terminalExited); a terminal already gone or a background run ends here.
    this.finish(r, code);
  }

  private finish(r: MockRun, code: number): void {
    if (r.state !== ActionRunState.RUNNING) return;
    for (const t of r.timers) clearTimeout(t);
    r.timers = [];
    r.state = ActionRunState.EXITED;
    r.exitCode = code;
    r.finishedAt = new Date();
    this.host.publish({ event: { case: "runUpdated", value: this.runMsg(r, false) } });
    this.host.publish({
      event: {
        case: "runFinished",
        value: { runId: r.id, actionId: r.actionId, actionName: r.actionName, projectId: r.projectId, threadId: r.threadId, exitCode: code, mode: r.mode, trigger: r.trigger, terminalId: r.terminalId },
      },
    });
    for (const w of r.waiters.splice(0)) w();
    this.trim(r.projectId);
  }

  /** Keeps the newest RUNS_PER_PROJECT runs of a project; a running run is never dropped. */
  private trim(projectId: string): void {
    const mine = this.runs.filter((r) => r.projectId === projectId);
    let extra = mine.length - RUNS_PER_PROJECT;
    for (let i = mine.length - 1; i >= 0 && extra > 0; i--) {
      const r = mine[i];
      if (!r || r.state === ActionRunState.RUNNING) continue;
      this.forget(r);
      extra--;
    }
  }

  private forget(r: MockRun): void {
    for (const t of r.timers) clearTimeout(t);
    this.runs = this.runs.filter((x) => x !== r);
    this.host.publish({ event: { case: "runRemovedId", value: r.id } });
  }

  /** terminal.kill: how long its SIGHUP goes unheeded (0: it ends the run at once). */
  hangupGraceMs(terminalId: string): number {
    const r = this.runs.find((x) => x.terminalId === terminalId && x.state === ActionRunState.RUNNING);
    return r?.ignoresHangup ? KILL_GRACE_MS : 0;
  }

  /** world.kill: a terminal's process exited. */
  terminalExited(terminalId: string, code: number): void {
    const r = this.runs.find((x) => x.terminalId === terminalId && x.state === ActionRunState.RUNNING);
    if (r) this.finish(r, code);
  }

  /** world.remove: a terminal went; a run still waiting on it finishes with -1. */
  terminalRemoved(terminalId: string): void {
    this.terminalExited(terminalId, -1);
  }

  /** Background runs matching are killed (SIGTERM: 143): their thread, worktree or project went. */
  stopBackground(match: (r: { threadId: string; worktreePath: string; projectId: string }) => boolean): void {
    for (const r of this.runs) if (r.mode === ActionRunMode.BACKGROUND && r.state === ActionRunState.RUNNING && match(r)) this.finish(r, 143);
  }

  /** POST /__mock/action/finish: a running run (by run id or terminal id) exits now with code. */
  finishNow(ref: { run?: string; terminal?: string }, code: number): RunInit {
    const r = this.runs.find((x) => (ref.run ? x.id === ref.run : x.terminalId === ref.terminal));
    if (!r) throw new CommandError("notfound", `no run ${ref.run ?? `in terminal ${ref.terminal ?? ""}`}`);
    if (r.state !== ActionRunState.RUNNING) throw new CommandError("unavailable", `run ${r.id} has already finished`);
    this.exitProcess(r, code);
    return this.runMsg(r, true);
  }

  /** A new thread created its worktree: the project's on-worktree-create actions, one after another, in the background. */
  worktreeCreated(threadId: string, projectId: string, worktree: string): void {
    const list = this.sorted(projectId).filter((a) => a.onWorktreeCreate);
    const gen = this.generation;
    void (async () => {
      for (const a of list) {
        if (gen !== this.generation || !this.actions.has(a.id)) continue;
        try {
          const r = this.start(a, { threadId, projectId, worktree }, ActionRunMode.BACKGROUND, ActionRunTrigger.WORKTREE_CREATE, scriptFor(a.command, worktree));
          await this.waitRun(r.id);
        } catch {
          // A reset dropped the run: stop.
          return;
        }
      }
    })();
  }

  /** POST /__mock/action/setup: a worktree-create run for a thread that exits with `code` after ~600 ms. */
  setupRun(threadId: string, code: number, actionRef = ""): RunInit {
    const owner = this.owner(threadId, "", "");
    const list = this.sorted(owner.projectId);
    const a = actionRef ? list.find((x) => x.id === actionRef || x.name.toLowerCase() === actionRef.toLowerCase()) : (list.find((x) => x.onWorktreeCreate) ?? list[0]);
    if (!a) throw new CommandError("notfound", `no action ${actionRef ? `"${actionRef}" ` : ""}in project ${owner.projectId}`);
    return this.runMsg(this.start(a, owner, ActionRunMode.BACKGROUND, ActionRunTrigger.WORKTREE_CREATE, setupScript(code)), true);
  }

  // ---- Commands -----------------------------------------------------------------

  /** The project the action commands work on (see commands_action.go actionProject). */
  private projectFor(ctx: UiContext | undefined, args: Record<string, string>): string {
    const projects = this.host.projects();
    const inside = (path: string) => {
      let best: { id: string; len: number } | null = null;
      for (const r of projects) for (const w of r.worktrees) if ((path === w || path.startsWith(`${w}/`)) && w.length > (best?.len ?? 0)) best = { id: r.id, len: w.length };
      return best?.id;
    };
    const ref = (args.project ?? "").trim();
    if (ref) {
      if (projects.some((r) => r.id === ref)) return ref;
      const named = projects.filter((r) => r.name === ref);
      if (named.length > 1) throw new CommandError("invalid", `${String(named.length)} projects are named ${ref}; pass an id (code-foundry project list)`);
      const id = named[0]?.id ?? (ref.startsWith("/") ? inside(ref) : undefined);
      if (!id) throw new CommandError("invalid", `no project "${ref}" (code-foundry project list)`);
      return id;
    }
    if (ctx?.activeThreadId) {
      const s = this.host.thread(ctx.activeThreadId);
      if (!s) throw new CommandError("notfound", `thread ${ctx.activeThreadId} not found`);
      if (!s.projectId) throw new CommandError("invalid", `thread ${ctx.activeThreadId} has no project; ${noProject}`);
      return s.projectId;
    }
    if (ctx?.activeProjectId && projects.some((r) => r.id === ctx.activeProjectId)) return ctx.activeProjectId;
    const id = (ctx?.activeWorktreePath && inside(ctx.activeWorktreePath)) || (args.here && inside(args.here));
    if (!id) throw new CommandError("invalid", noProject);
    return id;
  }

  /** An action by id anywhere, else by name in projectFor's project. */
  private find(ctx: UiContext | undefined, args: Record<string, string>): MockAction {
    const ref = (args.action ?? "").trim();
    const byId = this.actions.get(ref);
    if (byId) return byId;
    const projectId = this.projectFor(ctx, args);
    const a = this.sorted(projectId).find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!a) throw new CommandError("notfound", `no action "${ref}" in this project (code-foundry action list)`);
    return a;
  }

  private async waitMessage(id: string): Promise<InvokeWithCode> {
    const run = await this.waitRun(id);
    const code = run.exitCode ?? 0;
    let msg = "";
    if (run.mode === ActionRunMode.BACKGROUND) {
      if (run.outputTruncated) msg += "[earlier output dropped; the last 64 KiB follow]\n";
      const out = (run.output ?? "").replace(/\n+$/, "");
      if (out) msg += `${out}\n`;
    }
    const name = run.actionName ?? "";
    const runId = run.id ?? "";
    const term = run.terminalId ?? "";
    if (run.mode === ActionRunMode.TERMINAL && code === -1) msg += `terminal ${term} was closed before ${name} finished (run ${runId})`;
    else if (run.mode === ActionRunMode.TERMINAL) msg += `${name} exited with code ${String(code)} in terminal ${term} (run ${runId})`;
    else msg += `${name} exited with code ${String(code)} (run ${runId})`;
    return { message: msg, resultJson: toJsonString(ActionRunSchema, create(ActionRunSchema, run)), exitCode: code < 0 || code > 255 ? 1 : code };
  }

  /** action.list, action.add, action.edit, action.remove, action.run, action.wait, action.runs (internal/command/commands_action.go). */
  commands(): Command[] {
    const canUse = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId || ctx?.activeProjectId || ctx?.activeWorktreePath || !ctx?.activeView);
    const canRun = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId || ctx?.activeWorktreePath || !ctx?.activeView);
    const projectArg = { name: "project", type: ArgType.STRING, required: false, description: "Project: id, name, or a path inside it (default: the thread's, the worktree's, or the working directory's)" };
    const hereArg = {
      name: "here",
      type: ArgType.PATH,
      required: false,
      description: "Where the CLI runs: without a thread, worktree or --repo, its project is used (CLI default: the working directory)",
    };
    const refArg = { name: "action", type: ArgType.STRING, required: true, description: "Action name (ignoring case) or id" };
    const iconArg = { name: "icon", type: ArgType.ENUM, required: false, description: "Icon", enumValues: ICONS.map((x) => x.name) };
    const bool = (name: string, description: string, defaultValue?: string) => ({ name, type: ArgType.BOOL, required: false, description, ...(defaultValue ? { defaultValue } : {}) });
    const has = (args: Record<string, string>, name: string) => args[name] !== undefined && args[name] !== "";
    const icon = (name: string | undefined) => ICONS.find((x) => x.name === (name || "play"))?.icon ?? ActionIcon.UNSPECIFIED;
    const actionJson = (a: ActionInit) => toJsonString(ActionSchema, create(ActionSchema, a));
    const cmd = (name: string, title: string, description: string, args: Command["cmd"]["args"]) => ({ name, title, category: "Action", description, keybindings: [], args });
    return [
      {
        cmd: cmd("action.list", "List Actions", "List a project's actions: the commands `action run` starts, in order, with their ids.", [projectArg, hereArg]),
        when: canUse,
        run: (ctx, args) => {
          const res = this.list(this.projectFor(ctx, args));
          const acts = res.actions;
          const message =
            acts.length === 0
              ? "no actions in this project (add one: code-foundry action add <name> --command '<command line>')"
              : table([
                  ["NAME", "ID", "ICON", "RUNS IN", "ON NEW WORKTREE", "COMMAND"],
                  ...acts.map((a) => [a.name ?? "", a.id ?? "", iconName(a.icon ?? ActionIcon.PLAY), a.inTerminal ? "terminal" : "background", a.onWorktreeCreate ? "yes" : "no", `${(a.command ?? "").split("\n")[0] ?? ""}${(a.command ?? "").includes("\n") ? " …" : ""}`]),
                ]);
          return Promise.resolve({ message, resultJson: toJsonString(ListActionsResponseSchema, create(ListActionsResponseSchema, res)) });
        },
      },
      {
        cmd: cmd("action.add", "Add Action", "Add an action to a project: a command line run as `$SHELL -lc <command>` in a worktree. It opens as a terminal in the bottom panel, or with --in-terminal=false runs in the background with its output captured.", [
          { name: "name", type: ArgType.STRING, required: true, description: "Name, unique in the project (ignoring case)" },
          { name: "command", type: ArgType.STRING, required: true, description: "Command line (may span lines)" },
          { ...iconArg, defaultValue: "play" },
          bool("in-terminal", "Run in a terminal in the bottom panel (--in-terminal=false: in the background)", "true"),
          bool("on-worktree-create", "Also run (in the background) when a new thread creates its worktree", "false"),
          projectArg,
          hereArg,
        ]),
        when: canUse,
        run: (ctx, args) => {
          const a = this.create({
            projectId: this.projectFor(ctx, args),
            name: args.name ?? "",
            command: args.command ?? "",
            icon: icon(args.icon),
            inTerminal: args["in-terminal"] !== "false",
            onWorktreeCreate: args["on-worktree-create"] === "true",
          });
          return Promise.resolve({ message: `added action ${a.name ?? ""} (${a.id ?? ""})`, resultJson: actionJson(a) });
        },
      },
      {
        cmd: cmd("action.edit", "Edit Action", "Change an action's name, command, icon, where it runs, whether it runs for new worktrees, or its position.", [
          refArg,
          { name: "name", type: ArgType.STRING, required: false, description: "New name" },
          { name: "command", type: ArgType.STRING, required: false, description: "New command line" },
          iconArg,
          bool("in-terminal", "Run in a terminal (--in-terminal=false: in the background)"),
          bool("on-worktree-create", "Run when a new thread creates its worktree"),
          { name: "position", type: ArgType.INT, required: false, description: "Move to this 0-based place in the project's list" },
          projectArg,
          hereArg,
        ]),
        when: canUse,
        run: (ctx, args) => {
          const a = this.find(ctx, args);
          const fields = ["name", "command", "icon", "in-terminal", "on-worktree-create", "position"];
          if (!fields.some((f) => has(args, f))) {
            throw new CommandError("invalid", "nothing to change: pass --name, --command, --icon, --in-terminal, --on-worktree-create or --position");
          }
          if (has(args, "position") && !/^-?\d+$/.test(args.position ?? "")) throw new CommandError("invalid", "position must be a number");
          const out = this.update({
            id: a.id,
            name: has(args, "name") ? args.name : undefined,
            command: has(args, "command") ? args.command : undefined,
            icon: has(args, "icon") ? icon(args.icon) : undefined,
            inTerminal: has(args, "in-terminal") ? args["in-terminal"] === "true" : undefined,
            onWorktreeCreate: has(args, "on-worktree-create") ? args["on-worktree-create"] === "true" : undefined,
            position: has(args, "position") ? Number(args.position) : undefined,
          });
          return Promise.resolve({ message: `updated action ${out.name ?? ""}`, resultJson: actionJson(out) });
        },
      },
      {
        cmd: cmd("action.remove", "Remove Action", "Remove an action from its project. Runs in progress keep going.", [refArg, projectArg, hereArg]),
        when: canUse,
        run: (ctx, args) => {
          const a = this.find(ctx, args);
          this.delete(a.id);
          return `removed action ${a.name}`;
        },
      },
      {
        cmd: cmd(
          "action.run",
          "Run Action",
          "Run an action for the active thread (its bottom panel), else the active worktree, else the registered worktree containing the working directory. --background captures its output instead, --terminal opens it as a terminal. --wait waits for it to finish, prints a background run's output, and exits with the action's exit code.",
          [
            refArg,
            bool("background", "Run in the background with captured output, whatever the action says"),
            bool("terminal", "Run in a terminal in the bottom panel, whatever the action says"),
            bool("wait", "Wait for the run to finish; print its output (background) and exit with its code"),
            { name: "here", type: ArgType.PATH, required: false, description: "Where the CLI runs: without a thread or worktree, the registered worktree containing it owns the run (CLI default: the working directory)" },
          ],
        ),
        when: canRun,
        run: async (ctx, args) => {
          const bg = args.background === "true";
          const term = args.terminal === "true";
          if (bg && term) throw new CommandError("invalid", "--background and --terminal exclude each other");
          const mode = bg ? ActionRunMode.BACKGROUND : term ? ActionRunMode.TERMINAL : ActionRunMode.UNSPECIFIED;
          let worktreePath = "";
          if (!ctx?.activeThreadId) {
            const path = ctx?.activeWorktreePath || args.here || "";
            const projects = this.host.projects();
            const exact = projects.some((r) => r.worktrees.includes(path));
            let best = "";
            if (!exact) for (const r of projects) for (const w of r.worktrees) if (path.startsWith(`${w}/`) && w.length > best.length) best = w;
            worktreePath = exact ? path : best;
            if (!worktreePath) throw new CommandError("invalid", "action.run needs a thread, a worktree, or to run inside a registered project");
          }
          const run = this.run({ action: args.action ?? "", threadId: ctx?.activeThreadId ?? "", worktreePath, mode });
          if (args.wait === "true") return this.waitMessage(run.id ?? "");
          const json = toJsonString(ActionRunSchema, create(ActionRunSchema, run));
          if (run.mode === ActionRunMode.TERMINAL) return { message: `started ${run.actionName ?? ""} in terminal ${run.terminalId ?? ""} (run ${run.id ?? ""})`, resultJson: json };
          return { message: `started ${run.actionName ?? ""} in the background (run ${run.id ?? ""}); \`code-foundry action wait ${run.id ?? ""}\` prints its output`, resultJson: json };
        },
      },
      {
        cmd: cmd("action.wait", "Wait for Action Run", "Wait for an action run to finish, print its output (a background run's last 64 KiB), and exit with its exit code.", [
          { name: "run", type: ArgType.STRING, required: true, description: "Run id (r-...)" },
        ]),
        when: () => true,
        run: (_ctx, args) => this.waitMessage(args.run ?? ""),
      },
      {
        cmd: cmd("action.runs", "List Action Runs", "List a project's recent action runs (the daemon remembers the last 50 per project until it restarts), newest first.", [projectArg, hereArg]),
        when: canUse,
        run: (ctx, args) => {
          const res = this.list(this.projectFor(ctx, args));
          const message =
            res.runs.length === 0
              ? "no action runs in this project since the daemon started"
              : table([
                  ["RUN", "ACTION", "STATE", "WHERE", "OWNER", "STARTED"],
                  ...this.runs
                    .filter((r) => res.runs.some((x) => x.id === r.id))
                    .map((r) => [
                      r.id,
                      r.actionName,
                      r.state === ActionRunState.EXITED ? `exited ${String(r.exitCode)}` : "running",
                      r.mode === ActionRunMode.TERMINAL ? `terminal ${r.terminalId}` : "background",
                      r.threadId ? `thread ${r.threadId}` : r.worktreePath,
                      r.startedAt.toTimeString().slice(0, 8),
                    ]),
                ]);
          return Promise.resolve({ message, resultJson: toJsonString(ListActionsResponseSchema, create(ListActionsResponseSchema, res)) });
        },
      },
    ];
  }
}
