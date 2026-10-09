/**
 * In-memory fake daemon state: repos, worktrees, terminals with scripted output, the
 * command registry, and intent fan-out. Deterministic initial state; reset() restores it.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { EventSource, type EventSchema } from "../src/gen/codefoundry/v1/events_pb";
import type { RepoEventSchema, RepoSchema, WorktreeSchema } from "../src/gen/codefoundry/v1/repo_pb";
import { SessionState, SessionStatus, type SessionEventSchema, type SessionSchema } from "../src/gen/codefoundry/v1/session_pb";
import { TerminalState, type AttachEventSchema, type TerminalEventSchema, type TerminalSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";
import { MockGitOps, type GitOpsEventInit, type InvokeOut } from "./gitops";
import { prDetailCall } from "./prDetail";
import { GhWorld, ghEvent, viewCommands } from "./github";
import { Hub } from "./hub";
import { MockSettings } from "./settings";
import { MockUpdater } from "./update";
import { claudeIntro, claudeTick, ENTER_ALT, logLine, prompt, RESET, testRunOutput, topFrame } from "./screens";

type TerminalInit = MessageInitShape<typeof TerminalSchema>;
type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;
type TerminalEventInit = MessageInitShape<typeof TerminalEventSchema>;
type RepoInit = MessageInitShape<typeof RepoSchema>;
type WorktreeInit = MessageInitShape<typeof WorktreeSchema>;
type RepoEventInit = MessageInitShape<typeof RepoEventSchema>;
type SessionInit = MessageInitShape<typeof SessionSchema>;
type SessionEventInit = MessageInitShape<typeof SessionEventSchema>;
export type EventInit = MessageInitShape<typeof EventSchema>;

interface MockSession {
  id: string;
  claudeSessionId: string;
  repoId: string;
  worktreePath: string;
  name: string;
  autoNamed: boolean;
  model: string;
  effort: string;
  terminalId: string;
  state: SessionState;
  status: SessionStatus;
  createdAt: Date;
  lastActivityAt: Date;
  exitCode: number;
  disconnectReason: string;
  /** Mock-only: seconds left before a STARTING/CLOSING session settles. */
  settleIn: number;
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
  status: { upstream: string; ahead: number; behind: number; staged: number; modified: number; untracked: number; dirty: boolean; baseRef?: string; baseAhead?: number; baseBehind?: number };
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
  return { upstream: "origin/main", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, baseRef: "origin/main", baseAhead: 0, baseBehind: 0, ...over };
}

function initialRepos(): MockRepo[] {
  return [
    {
      id: "repo-cf",
      path: CF,
      name: "code-foundry",
      defaultBranch: "main",
      githubSlug: "alexwaumann/code-foundry",
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
      worktrees: [{ path: GP, branch: "main", head: "77aa55cc", isMain: true, status: clean({ staged: 1, dirty: true }) }],
    },
    {
      id: "repo-dot",
      path: `${HOME}/dotfiles`,
      name: "dotfiles",
      defaultBranch: "main",
      githubSlug: "",
      worktrees: [{ path: `${HOME}/dotfiles`, branch: "main", head: "0badc0de", isMain: true, status: clean({ upstream: "", baseRef: "" }) }],
    },
  ];
}

export class World {
  readonly startedAt = Date.now();
  terms = new Map<string, MockTerm>();
  repos = new Map<string, MockRepo>();
  sessions = new Map<string, MockSession>();
  /** EventService: every hub below tees into this one, so its order is publish order. */
  readonly events = new Hub<{ source: EventSource; event: EventInit }>();
  readonly termEvents = new Hub<TerminalEventInit>((v) => this.events.publish({ source: EventSource.TERMINAL, event: { event: { case: "terminal", value: v } } }));
  readonly repoEvents = new Hub<RepoEventInit>((v) => this.events.publish({ source: EventSource.REPO, event: { event: { case: "repo", value: v } } }));
  readonly sessionEvents = new Hub<SessionEventInit>((v) => this.events.publish({ source: EventSource.SESSION, event: { event: { case: "session", value: v } } }));
  readonly intents = new Hub<UiIntentInit>((v) => this.events.publish({ source: EventSource.UI, event: { event: { case: "ui", value: v } } }));
  readonly gitopsEvents = new Hub<GitOpsEventInit>((v) => this.events.publish({ source: EventSource.GITOPS, event: { event: { case: "gitops", value: v } } }));
  /** git.*, pr.*, worktree.open.editor, worktree.reveal, view.open.url (mock/gitops.ts). */
  readonly gitops = new MockGitOps((e) => this.gitopsEvents.publish(e));
  readonly settings = new MockSettings(
    () => this.registry().map((e) => e.cmd),
    (snap) => this.events.publish({ source: EventSource.SETTINGS, event: { event: { case: "settings", value: { event: { case: "snapshot", value: snap } } } } }),
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
    this.gitops.reset();
    this.settings.reset();
    this.writes = [];
    this.resizes = [];
    this.nextId = 1;
    for (const r of initialRepos()) this.repos.set(r.id, r);
    this.gh.reset();
    const started = new Date(Date.now() - 42 * 60_000);
    this.addTerm({ id: "t-claude", argv: ["claude"], cwd: CF, title: "✳ Refactor sidebar tree", kind: "claude", labels: { worktree: CF, session: "s-1" }, startedAt: started });
    this.addTerm({ id: "t-logs", argv: ["/bin/zsh"], cwd: `${CF}/internal/daemon`, title: "tail -f daemon.log", kind: "logs", labels: {}, startedAt: started });
    this.addTerm({ id: "t-top", argv: ["top"], cwd: `${CFW}/feat-sidebar`, title: "", kind: "top", labels: {}, startedAt: started });
    this.addTerm({ id: "t-tests", argv: ["go", "test", "./..."], cwd: `${CFW}/fix-resize`, title: "", kind: "exited", labels: { worktree: `${CFW}/fix-resize` }, startedAt: started });
    this.addTerm({ id: "t-ghostty", argv: ["claude", "--resume"], cwd: GP, title: "✳ Port renderer", kind: "claude", labels: { worktree: GP, session: "s-2" }, startedAt: started });
    this.addTerm({ id: "t-tmp", argv: ["/bin/zsh"], cwd: "/tmp", title: "", kind: "shell", labels: {}, startedAt: started });
    // Sessions in every state. s-1/s-2 own t-claude/t-ghostty (labels.session above).
    this.sessions.clear();
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    this.addSession({ id: "s-1", repoId: "repo-cf", worktreePath: CF, name: "Refactor sidebar tree", model: "opus", effort: "high", terminalId: "t-claude", status: SessionStatus.BUSY, createdAt: ago(42) });
    this.addSession({ id: "s-2", repoId: "repo-gp", worktreePath: GP, name: "Port renderer", model: "sonnet", effort: "", terminalId: "t-ghostty", status: SessionStatus.NEEDS_ATTENTION, createdAt: ago(40) });
    this.addSession({ id: "s-3", repoId: "repo-cf", worktreePath: `${CFW}/fix-resize`, name: "Fix resize race", model: "opus", effort: "medium", state: SessionState.DISCONNECTED, disconnectReason: "exited", createdAt: ago(300), lastActivityAt: ago(95) });
    this.addSession({ id: "s-4", repoId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Investigate flaky e2e", model: "haiku", effort: "", state: SessionState.DISCONNECTED, disconnectReason: "crashed", exitCode: 139, createdAt: ago(200), lastActivityAt: ago(17) });
    this.addSession({ id: "s-5", repoId: "repo-cf", worktreePath: `${CFW}/feat-sidebar`, name: "Write session docs", model: "opus", effort: "low", state: SessionState.STARTING, settleIn: 8, createdAt: ago(0) });
    this.addSession({ id: "s-6", repoId: "repo-dot", worktreePath: `${HOME}/dotfiles`, name: "Tidy zshrc", model: "sonnet", effort: "", state: SessionState.CLOSING, settleIn: 8, createdAt: ago(60) });
    // Republish so connected watchers converge on the reset state.
    for (const t of this.terms.values()) this.termEvents.publish({ event: { case: "updated", value: this.terminalMsg(t) } });
    for (const r of this.repos.values()) this.repoEvents.publish({ event: { case: "repoUpdated", value: this.repoMsg(r) } });
    this.sessionEvents.publish(this.sessionSnapshot());
    this.update.reset();
  }

  // ---- Sessions -----------------------------------------------------------------

  private addSession(o: Partial<MockSession> & Pick<MockSession, "id" | "repoId" | "worktreePath" | "name" | "model" | "effort">): MockSession {
    const state = o.state ?? SessionState.CONNECTED;
    let terminalId = o.terminalId ?? "";
    if (!terminalId && (state === SessionState.STARTING || state === SessionState.CONNECTED || state === SessionState.CLOSING)) {
      terminalId = this.sessionTerminal(o.id, o.worktreePath, o.model, false).id;
    }
    const s: MockSession = {
      claudeSessionId: `cl-${o.id}`,
      autoNamed: true,
      status: SessionStatus.IDLE,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      exitCode: 0,
      disconnectReason: "",
      settleIn: 0,
      ...o,
      state,
      terminalId,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  private sessionTerminal(sessionId: string, cwd: string, model: string, publish: boolean): MockTerm {
    const id = `t-${sessionId}-${String(this.nextId++)}`;
    const t = this.addTerm({ id, argv: ["claude", "--model", model || "opus"], cwd, title: "✳ Claude Code", kind: "claude", labels: { worktree: cwd, session: sessionId } });
    t.history = claudeIntro(cwd, t.cols, "continue where we left off");
    if (publish) this.publishTerm(t);
    return t;
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
      terminalId: s.terminalId,
      state: s.state,
      status: s.status,
      createdAt: timestampFromDate(s.createdAt),
      lastActivityAt: timestampFromDate(s.lastActivityAt),
      exitCode: s.exitCode,
      disconnectReason: s.disconnectReason,
    };
  }

  sessionSnapshot(): SessionEventInit {
    return { event: { case: "snapshot", value: { sessions: [...this.sessions.values()].map((s) => this.sessionMsg(s)) } } };
  }

  session(id: string): MockSession {
    const s = this.sessions.get(id);
    if (!s) throw new CommandError("notfound", `session ${id} not found`);
    return s;
  }

  private publishSession(s: MockSession): void {
    this.sessionEvents.publish({ event: { case: "updated", value: this.sessionMsg(s) } });
  }

  /** Session → disconnected. Its terminal is killed (if running) and removed first. */
  disconnectSession(id: string, reason: string, code: number): void {
    const s = this.session(id);
    const t = s.terminalId ? this.terms.get(s.terminalId) : undefined;
    // terminal_id clears in the same update that sets DISCONNECTED (the contract 2a keeps).
    s.terminalId = "";
    s.state = SessionState.DISCONNECTED;
    s.status = SessionStatus.IDLE;
    s.disconnectReason = reason;
    s.exitCode = code;
    s.settleIn = 0;
    s.lastActivityAt = new Date();
    this.publishSession(s);
    if (t) {
      this.kill(t.id, code, false);
      this.remove(t.id);
    }
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    const s = this.session(id);
    if (s.state === SessionState.DISCONNECTED) throw new CommandError("unavailable", "session is disconnected");
    s.status = status;
    s.lastActivityAt = new Date();
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

  private createSession(repoId: string, path: string, model: string, effort: string): MockSession {
    const id = `s-new-${String(this.nextId++)}`;
    const s = this.addSession({ id, repoId, worktreePath: path, name: "", model, effort, state: SessionState.STARTING, settleIn: 2, createdAt: new Date() });
    const t = this.terms.get(s.terminalId);
    if (t) this.publishTerm(t);
    this.publishSession(s);
    return s;
  }

  private reconnect(s: MockSession): void {
    const t = this.sessionTerminal(s.id, s.worktreePath, s.model, true);
    s.terminalId = t.id;
    s.state = SessionState.STARTING;
    s.settleIn = 2;
    s.disconnectReason = "";
    s.exitCode = 0;
    s.lastActivityAt = new Date();
    this.publishSession(s);
  }

  private tickSessions(): void {
    for (const s of this.sessions.values()) {
      if (s.settleIn > 0 && --s.settleIn === 0) {
        if (s.state === SessionState.STARTING) {
          s.state = SessionState.CONNECTED;
          s.status = SessionStatus.IDLE;
          if (!s.name) {
            s.name = "New session";
          }
          this.publishSession(s);
        } else if (s.state === SessionState.CLOSING) {
          this.disconnectSession(s.id, "closed", 0);
        }
        continue;
      }
      // s-1 alternates busy/idle every 4s; attention sticks until input arrives.
      if (s.id === "s-1" && s.state === SessionState.CONNECTED && s.status !== SessionStatus.NEEDS_ATTENTION && this.seconds % 4 === 0) {
        s.status = s.status === SessionStatus.BUSY ? SessionStatus.IDLE : SessionStatus.BUSY;
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
    this.tickSessions();
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
    const owner = [...this.sessions.values()].find((s) => s.terminalId === id);
    if (owner?.status === SessionStatus.NEEDS_ATTENTION) this.setSessionStatus(owner.id, SessionStatus.BUSY);
    if (owner && (t.line + text).replace(/\r$/, "").trim() === "/exit" && text.endsWith("\r")) {
      this.disconnectSession(owner.id, "exited", 0);
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

  /** Ends a terminal. A session whose process dies without a close request disconnects. */
  kill(id: string, code = 129, notifySession = true): void {
    const t = this.term(id);
    if (t.state !== TerminalState.RUNNING) return;
    const owner = notifySession ? [...this.sessions.values()].find((s) => s.terminalId === id && s.state !== SessionState.CLOSING) : undefined;
    if (owner) {
      this.disconnectSession(owner.id, code === 0 ? "exited" : "crashed", code);
      return;
    }
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

  /**
   * pr.ask, pr.explain and pr.fix.findings (internal/command/commands_prsession.go): start a
   * session about a pull request and focus it. The worktree rules follow the daemon's
   * pickPRWorktree; the prompt is not built here (the mock's sessions never read it).
   */
  private prSessionCommands(): ReturnType<World["registry"]> {
    const slugArg = { name: "repo-slug", type: ArgType.STRING, required: true, description: 'GitHub repository, "owner/name"' };
    const numberArg = { name: "number", type: ArgType.INT, required: true, description: "Pull request number" };
    const worktreeArg = { name: "worktree", type: ArgType.PATH, required: false, description: "Worktree to start the session in (default: picked from the registered clones of repo-slug and the pull request's branch)" };
    const modelArg = { name: "model", type: ArgType.ENUM, required: false, description: "Model (default: settings sessions.default_model, else Claude's default)", enumValues: ["fable", "opus", "sonnet", "haiku"] };
    const effortArg = { name: "effort", type: ArgType.ENUM, required: false, description: "Effort level (default: settings sessions.default_effort, else Claude's default)", enumValues: ["low", "medium", "high", "xhigh", "max"] };
    const start =
      (fix: boolean) =>
      (ctx: UiContext | undefined, args: Record<string, string>): string => {
        const slug = args["repo-slug"] ?? "";
        const n = Number(args.number);
        if (!slug.trim()) throw new CommandError("invalid", "repo-slug is required");
        if (!Number.isInteger(n) || n <= 0) throw new CommandError("invalid", "number must be a positive pull request number");
        const pr = prDetailCall(() => this.gh.prDetails.get(slug, n, fix)).pullRequest;
        const head = pr?.headRef ?? "";
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
          if (!first) throw new CommandError("unavailable", `no registered repository is a clone of ${slug}: add one with code-foundry repo register <path>, or pass --worktree`);
          const active = ctx?.activeWorktreePath;
          if (!fix && active) target = find((w) => w.path === active);
          if (!target && head) target = find((w) => w.branch === head);
          if (!target && !fix) target = { repoId: first.id, path: first.worktrees.find((w) => w.isMain)?.path ?? first.path };
          if (!target) {
            if (!head || pr?.isCrossRepository) throw new CommandError("unavailable", `#${String(n)} comes from a fork and no worktree of ${slug} is on its branch: check it out and pass --worktree`);
            const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${first.githubSlug}/${head.replace(/\//g, "-")}`, branch: head, head: pr?.headSha ?? "c0ffee00", isMain: false, status: clean({ upstream: "", baseRef: "" }) };
            first.worktrees.push(w);
            this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(first.id, w) } });
            target = { repoId: first.id, path: w.path };
          }
        }
        const s = this.createSession(target.repoId, target.path, args.model ?? "", args.effort ?? "");
        this.focusSession(s.id);
        return `Started session ${s.id} for PR #${String(n)}`;
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
            { name: "model", type: ArgType.ENUM, required: false, description: "Model", enumValues: ["opus", "sonnet", "haiku"], defaultValue: "opus" },
            { name: "effort", type: ArgType.ENUM, required: false, description: "Effort", enumValues: ["low", "medium", "high", "xhigh", "max"] },
          ],
        },
        when: (ctx) => this.worktreeOf(ctx) !== null,
        run: (ctx, args) => {
          const w = this.worktreeOf(ctx);
          if (!w) throw new CommandError("unavailable", "no active worktree");
          const model = args.model ?? "opus";
          const s = this.createSession(w.repo.id, w.wt.path, model, args.effort ?? "");
          this.focusSession(s.id);
          return `Started Claude (${model}${args.effort ? `, ${args.effort}` : ""}) in ${w.wt.branch}`;
        },
      },
      {
        cmd: { name: "session.close", title: "Close Session", category: "Session", description: "Exit Claude gracefully; the session stays, disconnected", keybindings: ["cmd+shift+w"], args: [] },
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
        cmd: { name: "session.fork", title: "Fork Session", category: "Session", description: "Start a new session that continues this one's conversation", keybindings: [], args: [{ name: "name", type: ArgType.STRING, required: false, description: "Name for the fork" }] },
        when: (ctx) => activeSession(ctx) !== undefined,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          const f = this.createSession(s.repoId, s.worktreePath, s.model, s.effort);
          this.focusSession(f.id);
          return `Forked ${s.name || s.id}`;
        },
      },
      {
        cmd: { name: "session.reconnect", title: "Reconnect Session", category: "Session", description: "Resume the session in a new terminal (claude --resume)", keybindings: ["cmd+shift+r"], args: [] },
        when: (ctx) => activeSession(ctx)?.state === SessionState.DISCONNECTED,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          this.reconnect(s);
          return "";
        },
      },
      {
        cmd: { name: "session.rename", title: "Rename Session", category: "Session", description: "Set the session's name", keybindings: ["cmd+r"], args: [{ name: "name", type: ArgType.STRING, required: true, description: "New name" }] },
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
          name: "session.remove", title: "Remove Session", category: "Session", description: "Forget the session (closes it first if connected)", keybindings: [], args: [],
          confirm: (ctx) => `Remove session ${ctx?.activeSessionId ?? ""}? It is closed first if connected, and its row is forgotten.`,
        },
        when: (ctx) => activeSession(ctx) !== undefined,
        run: (ctx) => {
          const s = activeSession(ctx);
          if (!s) throw new CommandError("unavailable", "no active session");
          if (s.state !== SessionState.DISCONNECTED) this.disconnectSession(s.id, "closed", 0);
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
        cmd: {
          name: "repo.unregister", title: "Unregister Repository", category: "Repository", description: "Stop tracking the active repository", keybindings: [], args: [],
          confirm: (ctx) => `Stop tracking repository ${ctx?.activeRepoId ?? ""}? Nothing on disk is touched.`,
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
        cmd: { name: "repo.refresh", title: "Refresh Git Status", category: "Repository", description: "Reconcile git status now", keybindings: ["cmd+alt+r"], args: [] },
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
          const w: MockWorktree = { path: `${HOME}/.code-foundry/worktrees/${repo.githubSlug || `_local/${repo.name}`}/${branch.replace(/\//g, "-")}`, branch, head: "c0ffee00", isMain: false, status: clean({ upstream: "", baseRef: "" }) };
          repo.worktrees.push(w);
          this.repoEvents.publish({ event: { case: "worktreeUpdated", value: this.worktreeMsg(repo.id, w) } });
          this.intents.publish({ intent: { case: "focusRepo", value: { repoId: repo.id, worktreePath: w.path } } });
          return `Created worktree ${branch}`;
        },
      },
      {
        cmd: {
          name: "worktree.remove", title: "Remove Worktree", category: "Worktree", description: "Remove the active worktree", keybindings: [],
          args: [{ name: "force", type: ArgType.BOOL, required: true, description: "Discard local changes?", defaultValue: "false" }],
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
          w.repo.worktrees = w.repo.worktrees.filter((x) => x !== w.wt);
          this.repoEvents.publish({ event: { case: "worktreeRemoved", value: { repoId: w.repo.id, path: w.wt.path } } });
          return `Removed worktree ${w.wt.branch}`;
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
          if (wt) return { repoId: repo.id, path: wt.path, branch: wt.branch, githubSlug: repo.githubSlug };
        }
        return null;
      }),
      ...this.gh.prDetails.commands(),
      ...this.prSessionCommands(),
      {
        cmd: { name: "view.settings", title: "Open Settings", category: "View", description: "Open the settings page", keybindings: ["cmd+,"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "settings" } } }))}`,
      },
      {
        cmd: { name: "view.help", title: "Keyboard Shortcuts and Help", category: "View", description: "Show keybindings and how the app works", keybindings: ["cmd+/"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "help" } } }))}`,
      },
      {
        cmd: { name: "view.panel.toggle", title: "Toggle Side Panel", category: "View", description: "Show or hide the side panel next to the selected session, terminal, worktree, or page.", keybindings: ["cmd+shift+e"], args: [] },
        when: always,
        run: () => `delivered=${String(this.emit({ intent: { case: "showView", value: { name: "panel.toggle" } } }))}`,
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
  private effectiveRegistry(): ReturnType<World["registry"]> {
    const entries = this.registry();
    const kb = this.settings.keybindings();
    const model = this.settings.values()["sessions.default_model"] ?? "";
    return entries.map((e) => ({
      ...e,
      cmd: {
        ...e.cmd,
        keybindings: kb[e.cmd.name] ?? e.cmd.keybindings,
        args: e.cmd.args.map((a) => (e.cmd.name === "session.new" && a.name === "model" && model && a.enumValues?.includes(model) ? { ...a, defaultValue: model } : a)),
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
        ? { activeTerminalId: ctx.activeTerminalId, activeSessionId: ctx.activeSessionId, activeRepoId: ctx.activeRepoId, activeWorktreePath: ctx.activeWorktreePath, activeView: ctx.activeView }
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
