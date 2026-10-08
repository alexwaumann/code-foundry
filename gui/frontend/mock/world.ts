/**
 * In-memory fake daemon state: repos, worktrees, terminals with scripted output, the
 * command registry, and intent fan-out. Deterministic initial state; reset() restores it.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import type { RepoEventSchema, RepoSchema, WorktreeSchema } from "../src/gen/codefoundry/v1/repo_pb";
import { TerminalState, type AttachEventSchema, type TerminalEventSchema, type TerminalSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, type UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";
import { Hub } from "./hub";
import { claudeIntro, claudeTick, ENTER_ALT, logLine, prompt, RESET, testRunOutput, topFrame } from "./screens";

type TerminalInit = MessageInitShape<typeof TerminalSchema>;
type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;
type TerminalEventInit = MessageInitShape<typeof TerminalEventSchema>;
type RepoInit = MessageInitShape<typeof RepoSchema>;
type WorktreeInit = MessageInitShape<typeof WorktreeSchema>;
type RepoEventInit = MessageInitShape<typeof RepoEventSchema>;

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
}
export type UiIntentInit = MessageInitShape<typeof UiIntentSchema>;

type Kind = "claude" | "logs" | "top" | "shell" | "exited";

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
  isMain: boolean;
  status: { upstream: string; ahead: number; behind: number; staged: number; modified: number; untracked: number; dirty: boolean };
}

interface MockRepo {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  githubSlug: string;
  worktrees: MockWorktree[];
}

export interface Invocation {
  name: string;
  context: Omit<UiContext, "$typeName" | "$unknown"> | null;
  args: Record<string, string>;
  at: string;
}

export class CommandError extends Error {
  constructor(
    readonly kind: "unavailable" | "invalid" | "notfound",
    message: string,
  ) {
    super(message);
  }
}

const HOME = "/Users/dev";
const CF = `${HOME}/src/code-foundry`;
const CFW = `${HOME}/src/code-foundry.worktrees`;
const GP = `${HOME}/src/ghostty-playground`;
const enc = new TextEncoder();
const HISTORY_CAP = 256 * 1024;

function clean(over: Partial<MockWorktree["status"]> = {}): MockWorktree["status"] {
  return { upstream: "origin/main", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, ...over };
}

function initialRepos(): MockRepo[] {
  return [
    {
      id: "repo-cf",
      path: CF,
      name: "code-foundry",
      defaultBranch: "main",
      githubSlug: "awaumann/code-foundry",
      worktrees: [
        { path: CF, branch: "main", head: "3c3c4651", isMain: true, status: clean() },
        { path: `${CFW}/feat-sidebar`, branch: "feat/sidebar", head: "9a8b7c6d", isMain: false, status: clean({ upstream: "origin/feat/sidebar", ahead: 2, modified: 3, untracked: 1, dirty: true }) },
        { path: `${CFW}/fix-resize`, branch: "fix/resize", head: "1f2e3d4c", isMain: false, status: clean({ upstream: "origin/fix/resize", behind: 1 }) },
      ],
    },
    {
      id: "repo-gp",
      path: GP,
      name: "ghostty-playground",
      defaultBranch: "main",
      githubSlug: "awaumann/ghostty-playground",
      worktrees: [{ path: GP, branch: "main", head: "77aa55cc", isMain: true, status: clean({ staged: 1, dirty: true }) }],
    },
    {
      id: "repo-dot",
      path: `${HOME}/dotfiles`,
      name: "dotfiles",
      defaultBranch: "main",
      githubSlug: "",
      worktrees: [{ path: `${HOME}/dotfiles`, branch: "main", head: "0badc0de", isMain: true, status: clean({ upstream: "" }) }],
    },
  ];
}

export class World {
  readonly startedAt = Date.now();
  terms = new Map<string, MockTerm>();
  repos = new Map<string, MockRepo>();
  readonly termEvents = new Hub<TerminalEventInit>();
  readonly repoEvents = new Hub<RepoEventInit>();
  readonly intents = new Hub<UiIntentInit>();
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
    this.invocations = [];
    this.writes = [];
    this.resizes = [];
    this.nextId = 1;
    for (const r of initialRepos()) this.repos.set(r.id, r);
    const started = new Date(Date.now() - 42 * 60_000);
    this.addTerm({ id: "t-claude", argv: ["claude"], cwd: CF, title: "✳ Refactor sidebar tree", kind: "claude", labels: { worktree: CF, session: "s-1" }, startedAt: started });
    this.addTerm({ id: "t-logs", argv: ["/bin/zsh"], cwd: `${CF}/internal/daemon`, title: "tail -f daemon.log", kind: "logs", labels: {}, startedAt: started });
    this.addTerm({ id: "t-top", argv: ["top"], cwd: `${CFW}/feat-sidebar`, title: "", kind: "top", labels: {}, startedAt: started });
    this.addTerm({ id: "t-tests", argv: ["go", "test", "./..."], cwd: `${CFW}/fix-resize`, title: "", kind: "exited", labels: { worktree: `${CFW}/fix-resize` }, startedAt: started });
    this.addTerm({ id: "t-ghostty", argv: ["claude", "--resume"], cwd: GP, title: "✳ Port renderer", kind: "claude", labels: { worktree: GP, session: "s-2" }, startedAt: started });
    this.addTerm({ id: "t-tmp", argv: ["/bin/zsh"], cwd: "/tmp", title: "", kind: "shell", labels: {}, startedAt: started });
    // Republish so connected watchers converge on the reset state.
    for (const t of this.terms.values()) this.termEvents.publish({ event: { case: "updated", value: this.terminalMsg(t) } });
    for (const r of this.repos.values()) this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(r) } });
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
      case "claude":
        t.history = claudeIntro(o.cwd, t.cols, o.id === "t-claude" ? "refactor the sidebar tree into a virtualized list" : "port the grid renderer to libghostty-vt");
        break;
      case "logs":
        t.history = `${prompt(o.cwd)}tail -f ~/Library/Application\\ Support/code-foundry/logs/daemon.log\r\n`;
        for (let i = 0; i < 12; i++) t.history += logLine(i, new Date(Date.now() - (12 - i) * 1000));
        break;
      case "top":
        t.history = `${prompt(o.cwd)}top\r\n`;
        t.altScreen = true;
        break;
      case "exited":
        t.history = testRunOutput(o.cwd);
        t.state = TerminalState.EXITED;
        t.exitCode = 1;
        t.exitedAt = new Date(Date.now() - 5 * 60_000);
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
    for (const t of this.terms.values()) {
      if (t.state !== TerminalState.RUNNING) continue;
      t.tick++;
      if (t.kind === "claude") {
        this.output(t, claudeTick(t.tick));
        if (t.tick % 6 === 0) {
          const base = t.title.replace(/^\S+\s/, "");
          this.setTitle(t, `${t.tick % 12 === 0 ? "✳" : "⠐"} ${base}`);
        }
      } else if (t.kind === "logs") {
        this.output(t, logLine(t.tick));
      } else if (t.kind === "top" && t.altScreen) {
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

  private setTitle(t: MockTerm, title: string): void {
    t.title = title;
    this.publishTerm(t);
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
    const t = this.addTerm({ id, argv, cwd, title: kind === "claude" ? "✳ New session" : "", kind, labels });
    if (kind === "claude") t.history = claudeIntro(cwd, t.cols, "hello");
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
    if (t.kind === "logs") {
      if (text.includes("\x03")) {
        t.kind = "shell";
        this.output(t, `^C\r\n${prompt(t.cwd)}`);
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
        if (t.kind === "claude") out += cmd ? `\x1b[32m⏺${RESET} (mock) You said: ${cmd}\r\n\r\n` : "";
        else out += cmd ? `zsh: command not found: ${cmd.split(" ")[0] ?? ""}\r\n${prompt(t.cwd)}` : prompt(t.cwd);
      } else if (ch === "\x7f") {
        if (t.line.length > 0) {
          t.line = t.line.slice(0, -1);
          out += "\b \b";
        }
      } else if (ch === "\x03") {
        t.line = "";
        out += `^C\r\n${t.kind === "claude" ? "" : prompt(t.cwd)}`;
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

  kill(id: string, code = 129): void {
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
  }

  remove(id: string): void {
    const t = this.term(id);
    if (t.state === TerminalState.RUNNING) throw new CommandError("unavailable", "terminal is still running");
    this.terms.delete(id);
    t.attach.publish("end");
    this.termEvents.publish({ event: { case: "removedId", value: id } });
  }

  // ---- Repo API -----------------------------------------------------------------

  worktreeMsg(repoId: string, w: MockWorktree): WorktreeInit {
    return { repoId, path: w.path, branch: w.branch, head: w.head, isMain: w.isMain, status: { ...w.status, refreshedAt: timestampFromDate(new Date()) } };
  }

  repoMsg(r: MockRepo): RepoInit {
    return { id: r.id, path: r.path, name: r.name, defaultBranch: r.defaultBranch, githubSlug: r.githubSlug, worktrees: r.worktrees.map((w) => this.worktreeMsg(r.id, w)) };
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

  /** The registry: definitions plus a `when` predicate over the caller's context. */
  private registry(): { cmd: CmdDef; when: (ctx: UiContext | undefined) => boolean; run: (ctx: UiContext | undefined, args: Record<string, string>) => string }[] {
    const activeTerm = (ctx: UiContext | undefined) => (ctx?.activeTerminalId ? this.terms.get(ctx.activeTerminalId) : undefined);
    const always = () => true;
    return [
      {
        cmd: { name: "terminal.new", title: "New Terminal", category: "Terminal", description: "Start a shell in the active worktree", keybindings: ["cmd+t"], args: [{ name: "cwd", type: ArgType.PATH, required: false, description: "Working directory" }] },
        when: always,
        run: (ctx, args) => {
          const cwd = args.cwd || ctx?.activeWorktreePath || HOME;
          const t = this.create(["/bin/zsh"], cwd, ctx?.activeWorktreePath ? { worktree: ctx.activeWorktreePath } : {}, "shell");
          this.intents.publish({ intent: { case: "focusTerminal", value: { terminalId: t.id } } });
          return `Started zsh in ${cwd}`;
        },
      },
      {
        cmd: {
          name: "session.new",
          title: "New Claude Session",
          category: "Session",
          description: "Start claude in the active worktree",
          keybindings: ["cmd+n"],
          args: [
            { name: "model", type: ArgType.ENUM, required: true, description: "Model", enumValues: ["opus", "sonnet", "haiku"], defaultValue: "opus" },
            { name: "effort", type: ArgType.ENUM, required: false, description: "Effort", enumValues: ["low", "medium", "high"], defaultValue: "high" },
          ],
        },
        when: (ctx) => this.worktreeOf(ctx) !== null,
        run: (ctx, args) => {
          const w = this.worktreeOf(ctx);
          if (!w) throw new CommandError("unavailable", "no active worktree");
          const t = this.create(["claude", "--model", args.model ?? "opus"], w.wt.path, { worktree: w.wt.path, session: `s-${String(this.nextId)}` }, "claude");
          this.intents.publish({ intent: { case: "focusTerminal", value: { terminalId: t.id } } });
          return `Started Claude (${args.model ?? "opus"}) in ${w.wt.branch}`;
        },
      },
      {
        cmd: { name: "terminal.kill", title: "Kill Terminal", category: "Terminal", description: "Send SIGHUP to the active terminal", keybindings: ["cmd+shift+w"], args: [] },
        when: (ctx) => activeTerm(ctx)?.state === TerminalState.RUNNING,
        run: (ctx) => {
          const t = activeTerm(ctx);
          if (!t) throw new CommandError("unavailable", "no active terminal");
          this.kill(t.id);
          return `Killed ${t.id}`;
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
        cmd: { name: "repo.register", title: "Register Repository", category: "Repository", description: "Track a git repository", keybindings: [], args: [{ name: "path", type: ArgType.PATH, required: true, description: "Path inside the repository" }] },
        when: always,
        run: (_ctx, args) => {
          const path = (args.path ?? "").replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, "");
          const name = path.split("/").pop() || path;
          const id = `repo-${name}`;
          const repo: MockRepo = { id, path, name, defaultBranch: "main", githubSlug: "", worktrees: [{ path, branch: "main", head: "deadbeef", isMain: true, status: clean() }] };
          this.repos.set(id, repo);
          this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(repo) } });
          return `Registered ${name}`;
        },
      },
      {
        cmd: { name: "repo.unregister", title: "Unregister Repository", category: "Repository", description: "Stop tracking the active repository", keybindings: [], args: [] },
        when: (ctx) => Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)),
        run: (ctx) => {
          const id = ctx?.activeRepoId ?? "";
          this.repos.delete(id);
          this.repoEvents.publish({ event: { case: "repoRemovedId", value: id } });
          return `Unregistered ${id}`;
        },
      },
      {
        cmd: { name: "repo.refresh", title: "Refresh Git Status", category: "Repository", description: "Reconcile git status now", keybindings: ["cmd+r"], args: [] },
        when: always,
        run: () => {
          for (const r of this.repos.values()) this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(r) } });
          return "Git status refreshed";
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
        when: (ctx) => Boolean(ctx?.activeRepoId && this.repos.has(ctx.activeRepoId)),
        run: (ctx, args) => {
          const repo = this.repos.get(ctx?.activeRepoId ?? "");
          if (!repo) throw new CommandError("unavailable", "no active repository");
          const branch = args.branch ?? "";
          const w: MockWorktree = { path: `${repo.path}.worktrees/${branch.replace(/\//g, "-")}`, branch, head: "c0ffee00", isMain: false, status: clean({ upstream: "" }) };
          repo.worktrees.push(w);
          this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
          this.intents.publish({ intent: { case: "focusRepo", value: { repoId: repo.id, worktreePath: w.path } } });
          return `Created worktree ${branch}`;
        },
      },
      {
        cmd: { name: "worktree.remove", title: "Remove Worktree", category: "Worktree", description: "Remove the active worktree", keybindings: [], args: [{ name: "force", type: ArgType.BOOL, required: true, description: "Discard local changes?", defaultValue: "false" }] },
        when: (ctx) => {
          const w = this.worktreeOf(ctx);
          return w !== null && !w.wt.isMain;
        },
        run: (ctx, args) => {
          const w = this.worktreeOf(ctx);
          if (!w) throw new CommandError("unavailable", "no active worktree");
          if (w.wt.status.dirty && args.force !== "true") throw new CommandError("unavailable", "worktree has local changes; use force");
          w.repo.worktrees = w.repo.worktrees.filter((x) => x !== w.wt);
          this.repoEvents.publish({ event: { case: "worktreeRemoved", value: { repoId: w.repo.id, path: w.wt.path } } });
          return `Removed worktree ${w.wt.branch}`;
        },
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
    ];
  }

  listCommands(ctx: UiContext | undefined, includeUnavailable: boolean): (CmdDef & { available: boolean })[] {
    return this.registry()
      .map(({ cmd, when }) => ({ ...cmd, available: when(ctx) }))
      .filter((c) => includeUnavailable || c.available);
  }

  invoke(name: string, ctx: UiContext | undefined, args: Record<string, string>): string {
    const entry = this.registry().find((e) => e.cmd.name === name);
    this.invocations.push({
      name,
      context: ctx
        ? { activeTerminalId: ctx.activeTerminalId, activeSessionId: ctx.activeSessionId, activeRepoId: ctx.activeRepoId, activeWorktreePath: ctx.activeWorktreePath, activeView: ctx.activeView }
        : null,
      args,
      at: new Date().toISOString(),
    });
    if (!entry) throw new CommandError("notfound", `unknown command ${name}`);
    if (!entry.when(ctx)) throw new CommandError("unavailable", `${name} is not available here`);
    for (const a of entry.cmd.args) {
      if (a.required && !args[a.name]) throw new CommandError("invalid", `missing required arg ${a.name}`);
    }
    return entry.run(ctx, args);
  }
}
