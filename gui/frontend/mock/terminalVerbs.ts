/**
 * The window shell's terminal verbs (internal/command commands_terminal_quick.go,
 * commands_terminal_shell.go, and tab.rename in commands_tab.go) over the mock's layout and
 * terminals: terminal.quick, terminal.cycle, terminal.reset, terminal.rerun and tab.rename. Each
 * answers the JSON its Go command answers. The rules behind them (the ring's order, a reset's
 * directory, rerun's refusals) are tested in Go; this is enough for the window to drive.
 * See docs/notes/shell-13-terminals.md.
 */
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { CommandError } from "./errors";
import { layoutRpcError, panes, type MockLayout, type Op, type Result, type Space, type State, type Tab } from "./layout";

interface Arg {
  name: string;
  type: ArgType;
  required: boolean;
  description: string;
  positional?: boolean;
}

interface Out {
  message: string;
  resultJson: string;
}

interface Entry {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: Arg[]; noPalette?: boolean };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => Promise<Out>;
}

/** What the verbs need of the world (mock/world.ts). */
export interface TerminalVerbsWorld {
  readonly layout: MockLayout;
  /** The thread's running quick shell, started when it has none: its id. */
  ensureQuick(thread: string): string;
  /** terminal.reset: the fresh shell's id; its tab follows it. */
  reset(id: string): string;
  /** terminal.rerun: the line typed. */
  rerun(id: string, command: string): string;
}

const arg = (name: string, type: ArgType, description: string, extra: Partial<Arg> = {}): Arg => ({ name, type, required: false, description, ...extra });

function refuse(message: string): never {
  throw new CommandError("invalid", message);
}

function allTabs(st: State): { sp: Space; pane: string; tab: Tab }[] {
  return st.spaces.flatMap((sp) => panes(sp.root).flatMap((p) => (p.tabs ?? []).map((tab) => ({ sp, pane: p.id, tab }))));
}

/** The current space's focused tab. */
function focusedTab(st: State): Tab | undefined {
  const sp = st.spaces.find((s) => s.id === st.current_space);
  const pane = panes(sp?.root).find((p) => p.id === sp?.focus);
  return pane?.tabs?.find((t) => t.id === pane.active);
}

export function terminalShellCommands(world: TerminalVerbsWorld): Entry[] {
  const L = world.layout;
  const always = () => true;
  const apply = (op: Op): { rev: number; result: Result; changed: boolean } => {
    const before = L.rev;
    try {
      const out = L.apply(op);
      return { ...out, changed: out.rev !== before };
    } catch (err) {
      throw layoutRpcError(err) as Error;
    }
  };
  const ok = (message: string, json: unknown): Promise<Out> => Promise.resolve({ message, resultJson: JSON.stringify(json) });
  return [
    {
      cmd: {
        name: "terminal.quick",
        title: "Toggle Quick Terminal",
        category: "Terminal",
        description: "Open or close a thread's quick terminal, the shell drawn under its conversation in its pane.",
        keybindings: ["cmd+j"],
        args: [
          arg("id", ArgType.STRING, "The thread (default: the focused tab's)", { positional: true }),
          arg("open", ArgType.BOOL, "Open it (default: toggle)"),
          arg("close", ArgType.BOOL, "Close it (default: toggle)"),
          arg("height", ArgType.INT, "Its height in layout px"),
          arg("focus", ArgType.BOOL, "Go to the thread"),
        ],
      },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const thread = a.id || focusedTab(st)?.thread || "";
        if (!thread) refuse("invalid argument: id: the focused tab belongs to no thread: name one");
        const open = st.threads?.[thread]?.quick?.open === true;
        const height = a.height ? Number(a.height) : 0;
        if (a.height && a.open !== "true" && a.close !== "true") {
          const c = apply({ op: "set_quick", thread, open, height });
          return ok("", { rev: c.rev, thread_id: thread, open });
        }
        const want = a.open === "true" ? true : a.close === "true" ? false : !open;
        let terminal = "";
        if (want) {
          terminal = world.ensureQuick(thread);
          if (a.focus === "true") apply({ op: "open_thread", thread, focus: true });
        }
        const c = apply({ op: "set_quick", thread, open: want, ...(height ? { height } : {}) });
        return ok("", { rev: c.rev, thread_id: thread, open: want, ...(terminal ? { terminal_id: terminal } : {}) });
      },
    },
    {
      cmd: {
        name: "terminal.cycle",
        title: "Cycle Thread Terminals",
        category: "Terminal",
        description: "Focus the next step of a thread's ring: its tab, each of its terminal tabs in layout order, its tab again.",
        keybindings: ["cmd+shift+j"],
        args: [arg("tab", ArgType.STRING, "The tab to step from (default: the focused tab)"), arg("focus", ArgType.BOOL, "Take the focus")],
      },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const all = allTabs(st);
        const from = (a.tab ? all.find((x) => x.tab.id === a.tab)?.tab : focusedTab(st)) ?? refuse(`invalid argument: no tab "${a.tab ?? ""}"`);
        const thread = from.thread ?? "";
        if (!thread) throw new CommandError("unavailable", `failed precondition: tab ${from.id} belongs to no thread`);
        const space = st.threads?.[thread]?.space ?? st.default_space;
        const ring = all.filter((x) => x.sp.id === space && x.tab.thread === thread && x.tab.kind === "terminal").map((x) => x.tab.id);
        const own = all.find((x) => x.tab.kind === "thread" && x.tab.thread === thread)?.tab.id;
        const i = ring.indexOf(from.id);
        const next = from.kind === "terminal" ? (ring[i + 1] ?? own ?? "") : (ring[0] ?? "");
        if (!next && from.kind === "terminal") {
          const c = apply({ op: "open_thread", thread, focus: true });
          return ok(`opened thread ${thread}`, { rev: c.rev, changed: c.changed, ...c.result });
        }
        if (!next) return ok(`thread ${thread} has no terminal tab to cycle to`, { rev: L.rev, changed: false });
        const c = apply({ op: "focus_tab", tab: next });
        return ok(`focused tab ${next}`, { rev: c.rev, changed: c.changed, ...c.result });
      },
    },
    {
      cmd: { name: "terminal.reset", title: "Reset Terminal", category: "Terminal", description: "Start a fresh shell in its owner's directory under the same tab, and close this one.", keybindings: [], args: [arg("id", ArgType.STRING, "The terminal", { positional: true })] },
      when: always,
      run: (ctx, a) => {
        const id = a.id || ctx?.activeTerminalId || "";
        const fresh = world.reset(id);
        return ok(`reset terminal ${id}: ${fresh}`, { id: fresh });
      },
    },
    {
      cmd: {
        name: "terminal.rerun",
        title: "Run Last Command Again",
        category: "Terminal",
        description: "Type a shell's last command into it again (--command: another).",
        keybindings: [],
        args: [arg("id", ArgType.STRING, "The terminal", { positional: true }), arg("command", ArgType.STRING, "The command line to run instead")],
      },
      when: always,
      run: (ctx, a) => {
        const id = a.id || ctx?.activeTerminalId || "";
        const line = world.rerun(id, a.command ?? "");
        return ok(`ran ${line} in terminal ${id}`, {});
      },
    },
    {
      cmd: {
        name: "tab.rename",
        title: "Rename Tab",
        category: "Layout",
        description: "Rename a tab (default: the focused tab): a thread's tab renames the thread, a terminal's takes a name of its own; --auto goes back to the automatic name.",
        keybindings: ["cmd+r"],
        args: [arg("tab", ArgType.STRING, "The tab", { positional: true }), arg("name", ArgType.STRING, "The name"), arg("auto", ArgType.BOOL, "Go back to the automatic name")],
      },
      when: always,
      run: (_c, a) => {
        if (a.auto === "true" && a.name) refuse("invalid argument: auto: --auto and --name together");
        const tab = a.tab || focusedTab(L.state())?.id || "";
        const c = apply({ op: "rename_tab", tab, name: a.auto === "true" ? "" : (a.name ?? "") });
        return ok(`renamed tab ${tab}`, { rev: c.rev, changed: c.changed, ...c.result });
      },
    },
    {
      // internal/command commands_tab.go tab.auto-name. The mock renames terminal tabs only; a thread's name is the daemon's.
      cmd: {
        name: "tab.auto-name",
        title: "Name Tab Automatically",
        category: "Layout",
        description: "Give a tab its automatic name again (default: the focused tab): a thread's is generated again, a terminal's tab drops its own name.",
        keybindings: ["cmd+shift+r"],
        args: [arg("tab", ArgType.STRING, "The tab", { positional: true })],
      },
      when: always,
      run: (_c, a) => {
        const tab = a.tab || focusedTab(L.state())?.id || "";
        const c = apply({ op: "rename_tab", tab, name: "" });
        return ok(`tab ${tab} goes by its automatic name`, { rev: c.rev, changed: c.changed, ...c.result });
      },
    },
  ];
}
