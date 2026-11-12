/**
 * What a terminal tab is called and the icon it shows (docs/notes/shell-model.md, "Terminals"):
 * a manual name sticks; otherwise what runs in it (the foreground job's command line, from the
 * process list: Terminal.foreground), with an icon by the kind of command; idle, its shell and
 * folder ("zsh · code-foundry"). Pure: the tab reads the terminal and passes the facts in.
 * The quick terminal's and linked tabs' directory hint is here too (`cwdHint`).
 * See docs/notes/shell-13-terminals.md.
 */
import { basename, tildify } from "./path";

/** The kinds of command a tab's icon tells apart; components/shell/terminalIcons.ts draws them. */
export type TerminalIconKind = "shell" | "git" | "package" | "build" | "editor" | "remote" | "container" | "monitor" | "log" | "database" | "python" | "agent" | "run";

/** The icon by a command's program name (its base name, lower case). One row per kind. */
const ICONS: readonly (readonly [TerminalIconKind, readonly string[]])[] = [
  ["git", ["git", "gh", "tig", "lazygit", "jj"]],
  ["package", ["npm", "npx", "pnpm", "yarn", "bun", "bunx", "node", "deno", "vite", "vitest", "playwright"]],
  ["build", ["make", "just", "cargo", "go", "gradle", "mvn", "cmake", "ninja", "task", "bazel", "swift", "xcodebuild", "zig", "rustc", "gcc", "clang"]],
  ["editor", ["vim", "nvim", "vi", "nano", "emacs", "hx", "helix", "micro", "kak"]],
  ["remote", ["ssh", "mosh", "scp", "sftp", "rsync", "telnet"]],
  ["container", ["docker", "podman", "kubectl", "k9s", "helm", "colima"]],
  ["monitor", ["top", "htop", "btop", "glances", "watch", "iftop", "nvtop"]],
  ["log", ["tail", "less", "more", "man", "bat", "journalctl", "log"]],
  ["database", ["psql", "mysql", "sqlite3", "redis-cli", "mongosh", "pgcli"]],
  ["python", ["python", "python3", "pip", "pip3", "uv", "uvx", "pytest", "ipython", "poetry"]],
  ["agent", ["claude", "code-foundry"]],
];

const BY_PROGRAM = new Map(ICONS.flatMap(([kind, names]) => names.map((n) => [n, kind] as const)));

/** Shells a terminal's argv may start; anything else in argv[0] is a program run in the terminal (an action). */
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh"]);

/** Words before a command's program that are not it: a prefix command, or `VAR=value`. */
const PREFIXES = new Set(["sudo", "env", "exec", "time", "nohup", "nice", "command", "caffeinate"]);

/** A command line's program: the first word that is not a prefix or an assignment, by its base name. */
export function programOf(command: string): string {
  for (const raw of command.trim().split(/\s+/)) {
    const word = raw.replace(/^['"]|['"]$/g, "");
    if (!word || PREFIXES.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith("-")) continue;
    return basename(word).toLowerCase();
  }
  return "";
}

/** A command line's icon; a program not in the table runs as `run`. */
export function commandIcon(command: string): TerminalIconKind {
  const program = programOf(command);
  if (!program) return "shell";
  const kind = BY_PROGRAM.get(program);
  if (kind) return kind;
  // python3.12, node22 and the like.
  const stem = program.replace(/[\d.]+$/, "");
  return BY_PROGRAM.get(stem) ?? (SHELLS.has(program) ? "shell" : "run");
}

/** A shell's name from its argv[0] ("-zsh" for a login shell, "/bin/zsh"). */
export function shellName(argv0: string): string {
  return basename(argv0).replace(/^-/, "");
}

/** A folder as an idle tab names it: "~" for the home directory, else its last segment. */
export function folderName(dir: string): string {
  if (!dir) return "";
  return tildify(dir) === "~" ? "~" : basename(dir);
}

/** What a tab's name is made from. */
export interface TerminalNameInput {
  /** The tab's manual name (the layout tab's `name`); "" for the automatic one. */
  manual: string;
  /** The terminal's argv; [] while it is not known yet. */
  argv: readonly string[];
  /** Where the shell is now (live_cwd), else where it started. */
  dir: string;
  /** The foreground job's command line; "" at the prompt. */
  foreground: string;
}

export interface TerminalName {
  name: string;
  icon: TerminalIconKind;
  /** The name is the automatic one (no manual name). */
  auto: boolean;
}

/**
 * A terminal tab's name and icon. A manual name sticks, with the icon of what runs. Otherwise
 * what runs; idle, its shell and folder. A terminal that is not a shell (an action run) is named
 * by its own command line.
 */
export function terminalName({ manual, argv, dir, foreground }: TerminalNameInput): TerminalName {
  const running = foreground.trim();
  const program = argv[0] ?? "";
  const isShell = !program || SHELLS.has(shellName(program));
  const icon = running ? commandIcon(running) : isShell ? "shell" : commandIcon(argv.join(" "));
  if (manual.trim()) return { name: manual.trim(), icon, auto: false };
  if (running) return { name: running, icon, auto: true };
  if (!isShell) return { name: [basename(program), ...argv.slice(1).map((a) => (a.includes(" ") ? `'${a}'` : a))].join(" "), icon, auto: true };
  const shell = program ? shellName(program) : "shell";
  const folder = folderName(dir);
  return { name: folder ? `${shell} · ${folder}` : shell, icon, auto: true };
}

/**
 * A directory as compared for the hint: no trailing slash, and macOS's /private/tmp and
 * /private/var as the /tmp and /var a thread's path names (the process table resolves them).
 */
export function normalizeDir(dir: string): string {
  const trimmed = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  return trimmed.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "");
}

/**
 * The directory hint (docs/notes/shell-model.md, "Terminals"): the shell has moved away from its
 * thread's directory. Nothing when either is unknown (a shell of no thread has nothing to go
 * back to), and never for a terminal that is not running.
 */
export function cwdHint(liveCwd: string, threadDir: string): { threadDir: string } | null {
  if (!liveCwd || !threadDir) return null;
  return normalizeDir(liveCwd) === normalizeDir(threadDir) ? null : { threadDir };
}
