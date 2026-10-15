import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { SessionView } from "@/api/session";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { chordFires, commandBindings, handleKeyDown, isGlobalChord, openRunInPicker } from "./bindings";

const runCommandForResult = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
// The re-list a chord on a stale list waits for: a test sets what it lists.
const relist = vi.hoisted(() => ({ run: (): void => undefined }));
vi.mock("@/stores/commands", async (orig) => ({
  ...(await orig<typeof import("@/stores/commands")>()),
  runCommandForResult,
  refreshCommands: vi.fn(() => {
    relist.run();
    return Promise.resolve();
  }),
  whenListed: vi.fn(() => Promise.resolve()),
}));

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "c", title: "C", description: "", category: "X", args: [], keybindings: [], available: true, ...over };
}

function session(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    claudeSessionId: "",
    repoId: "",
    worktreePath: "/src/app",
    name: id,
    autoNamed: false,
    model: "",
    effort: "",
    state: "connected",
    status: "idle",
    statusReason: "",
    statusChangedAtMs: null,
    createdAtMs: 1,
    lastActivityAtMs: null,
    parentId: "",
    permissionMode: "",
    baseRef: "",
    createdWorktree: false,
    workspaceId: "",
    pendingWorktreePath: "",
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    effortPending: false,
    linkedPullRequests: [],
    usage: [],
    costUsd: 0,
    unpriced: false,
    agentRuns: [],
    contextTokens: 0,
    cacheExpiresAtMs: null,
    contextRereadUsd: 0,
    agentsRunning: 0,
    backgroundAgentsRunning: 0,
    backgroundShellsRunning: 0,
    backgroundWakePending: false,
    retry: null,
    ...over,
  };
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe("commandBindings", () => {
  it("binds only available commands, first binding wins, chords normalized", () => {
    const map = commandBindings([
      cmd({ name: "a", keybindings: ["Shift+Cmd+N"] }),
      cmd({ name: "b", keybindings: ["cmd+shift+n", "cmd+j"] }),
      cmd({ name: "c", keybindings: ["cmd+x"], available: false }),
    ]);
    expect(map.get("cmd+shift+n")?.name).toBe("a");
    expect(map.get("cmd+j")?.name).toBe("b");
    expect(map.has("cmd+x")).toBe(false);
  });
});

describe("handleKeyDown precedence", () => {
  let terminal: HTMLElement;
  let outside: HTMLElement;
  let input: HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML = '<div data-terminal-host><textarea id="xt"></textarea></div><div id="out" tabindex="0"></div><input id="in" />';
    terminal = document.getElementById("xt") as HTMLElement;
    outside = document.getElementById("out") as HTMLElement;
    input = document.getElementById("in") as HTMLInputElement;
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    useUiStore.setState({ palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" }, sidebarVisible: true });
    useCommandsStore.setState({
      commands: [
        cmd({ name: "terminal.new", keybindings: ["cmd+t"] }),
        cmd({ name: "terminal.clear", keybindings: ["ctrl+l"] }),
        cmd({ name: "edit.copy", keybindings: ["cmd+c"] }),
        cmd({ name: "session.new", keybindings: ["cmd+n"], available: false, args: [{ name: "model", type: "enum", required: true, description: "", enumValues: ["opus"], defaultValue: "" }] }),
        cmd({ name: "worktree.create", keybindings: ["cmd+alt+n"], args: [{ name: "branch", type: "string", required: true, description: "", enumValues: [], defaultValue: "" }] }),
        cmd({ name: "session.rename", keybindings: ["cmd+r"], args: [{ name: "name", type: "string", required: true, description: "", enumValues: [], defaultValue: "" }] }),
      ],
    });
    useSessionsStore.setState({ byId: {}, order: [] });
    useUiStore.setState({ selection: { kind: "none" }, renamingSessionId: null, workingCollapsed: false });
    // The list is for the current context.
    useCommandsStore.setState({ contextKey: contextKey(getUiContext()) });
    relist.run = () => undefined;
    runCommandForResult.mockClear();
  });

  afterEach(() => {
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
  });

  it("global chords win even inside the terminal", () => {
    const e = press(terminal, { key: "k", code: "KeyK", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useUiStore.getState().palette.open).toBe(true);
    expect(isGlobalChord("cmd+shift+p")).toBe(true);
    expect(isGlobalChord("cmd+shift+a")).toBe(true);
  });

  it.each<[string, KeyboardEventInit & { key: string }, boolean]>([
    ["cmd chord bound to a command runs from the terminal", { key: "t", code: "KeyT", metaKey: true }, true],
    ["non-cmd command chord goes to the PTY", { key: "l", code: "KeyL", ctrlKey: true }, false],
    ["clipboard chord stays with the terminal even if bound", { key: "c", code: "KeyC", metaKey: true }, false],
    ["unbound cmd chord goes to the terminal", { key: "j", code: "KeyJ", metaKey: true }, false],
  ])("terminal focus: %s", (_name, init, runs) => {
    const e = press(terminal, init);
    expect(e.defaultPrevented).toBe(runs);
    expect(runCommandForResult).toHaveBeenCalledTimes(runs ? 1 : 0);
    expect(isGlobalChord(init.metaKey ? `cmd+${init.key}` : `ctrl+${init.key}`)).toBe(runs);
  });

  it.each<[string, KeyboardEventInit & { key: string }, boolean]>([
    ["a cmd chord bound to a command runs from the thread prompt", { key: "t", code: "KeyT", metaKey: true }, true],
    ["an editing chord stays with the prompt", { key: "c", code: "KeyC", metaKey: true }, false],
    ["a plain key stays with the prompt", { key: "t", code: "KeyT" }, false],
  ])("thread prompt focus ([data-chord-yield]): %s", (_name, init, runs) => {
    document.body.insertAdjacentHTML("beforeend", '<div data-chord-yield><div id="pr" contenteditable="true"></div></div>');
    const prompt = document.getElementById("pr") as HTMLElement;
    const e = press(prompt, init);
    expect(e.defaultPrevented).toBe(runs);
    expect(runCommandForResult).toHaveBeenCalledTimes(runs ? 1 : 0);
    // A text field outside a prompt keeps every chord.
    runCommandForResult.mockClear();
    expect(press(input, init).defaultPrevented).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("thread prompt focus: an unbound cmd chord on a list for an older context stays with the prompt (cmd+backspace)", () => {
    document.body.insertAdjacentHTML("beforeend", '<div data-chord-yield><div id="pr" contenteditable="true"></div></div>');
    useCommandsStore.setState({ contextKey: "older" });
    const e = press(document.getElementById("pr") as HTMLElement, { key: "Backspace", code: "Backspace", metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("thread prompt focus: a declared cmd chord on a list for an older context waits for the re-list (cmd+t right after selecting a thread)", async () => {
    document.body.insertAdjacentHTML("beforeend", '<div data-chord-yield><div id="pr" contenteditable="true"></div></div>');
    const commands = useCommandsStore.getState().commands;
    useCommandsStore.setState({ commands: commands.map((c) => (c.name === "terminal.new" ? { ...c, available: false } : c)), contextKey: "older" });
    relist.run = () => {
      useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext()) });
    };
    const e = press(document.getElementById("pr") as HTMLElement, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(runCommandForResult).toHaveBeenCalledWith("terminal.new", {}, expect.objectContaining({ quiet: true }));
    });
  });

  it("terminal focus: a cmd chord on a list for an older context waits for the re-list (cmd+t right after focusing a shell)", async () => {
    const commands = useCommandsStore.getState().commands;
    useCommandsStore.setState({ commands: commands.map((c) => (c.name === "terminal.new" ? { ...c, available: false } : c)), contextKey: "older" });
    relist.run = () => {
      useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext()) });
    };
    const e = press(terminal, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(runCommandForResult).toHaveBeenCalledWith("terminal.new", {}, expect.objectContaining({ quiet: true }));
    });
  });

  it("session.rename's chord starts the inline rename instead of the palette", () => {
    useSessionsStore.setState({ byId: { s1: session("s1") }, order: ["s1"] });
    useUiStore.setState({ selection: { kind: "session", id: "s1" } });
    press(terminal, { key: "r", code: "KeyR", metaKey: true });
    expect(useUiStore.getState().renamingSessionId).toBe("s1");
    expect(useUiStore.getState().palette.open).toBe(false);
  });

  it("F2 renames the selected session outside the tree", () => {
    useSessionsStore.setState({ byId: { s1: session("s1") }, order: ["s1"] });
    useUiStore.setState({ selection: { kind: "session", id: "s1" } });
    press(outside, { key: "F2", code: "F2" });
    expect(useUiStore.getState().renamingSessionId).toBe("s1");
  });

  it("cmd+shift+a cycles through sessions needing attention in sidebar order (newest first)", () => {
    useSessionsStore.setState({
      byId: { a: session("a", { status: "attention" }), b: session("b"), c: session("c", { status: "attention" }) },
      order: ["a", "b", "c"],
    });
    const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "c" });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "a" });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "c" });
  });

  it("cmd+shift+a visits prompts before finished turns, as the sidebar lists them", () => {
    useSessionsStore.setState({
      byId: {
        a: session("a", { status: "attention", statusReason: "finished" }),
        b: session("b", { status: "attention", statusReason: "question: Which?" }),
        c: session("c", { status: "attention", statusReason: "finished" }),
        d: session("d", { status: "error", statusReason: "interrupted" }),
      },
      order: ["a", "b", "c", "d"],
    });
    const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      jump();
      const sel = useUiStore.getState().selection;
      seen.push(sel.kind === "session" ? sel.id : "");
    }
    expect(seen).toEqual(["b", "c", "a", "b"]);
  });

  describe("cmd+1..9 follow the sidebar's groups", () => {
    // Creation order a..f: the sidebar shows f (pinned, busy), d (question), b (interrupted),
    // e (finished), c (idle), then under Working: a (busy).
    beforeEach(() => {
      useSessionsStore.setState({
        byId: {
          a: session("a", { status: "busy" }),
          b: session("b", { state: "disconnected", status: "error", statusReason: "interrupted" }),
          c: session("c"),
          d: session("d", { status: "attention", statusReason: "question: Which?" }),
          e: session("e", { status: "attention", statusReason: "finished" }),
          f: session("f", { status: "busy", pinned: true }),
        },
        order: ["a", "b", "c", "d", "e", "f"],
      });
    });
    const jumpTo = (n: number) => {
      press(outside, { key: String(n), code: `Digit${String(n)}`, metaKey: true });
      const sel = useUiStore.getState().selection;
      return sel.kind === "session" ? sel.id : "";
    };

    it("expanded: pinned, prompts, errors, finished, idle, working", () => {
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["f", "d", "b", "e", "c", "a"]);
    });

    it("a stopped idle thread sorts with the idle ones; a starting one keeps a saved finished turn, or is Working once busy", () => {
      // An MCP check starts e without a message: it still waits on the user (never in Working).
      useSessionsStore.setState((s) => ({
        byId: { ...s.byId, c: session("c", { state: "disconnected", status: "idle" }), e: session("e", { state: "starting", status: "attention", statusReason: "finished" }) },
      }));
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["f", "d", "b", "e", "c", "a"]);
      // A message starts it: the daemon says busy at once.
      useSessionsStore.setState((s) => ({ byId: { ...s.byId, e: session("e", { state: "starting", status: "busy", statusReason: "working" }) } }));
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["f", "d", "b", "c", "e", "a"]);
    });

    it("collapsed: the hidden Working rows are skipped (cmd+6 does nothing)", () => {
      useUiStore.setState({ workingCollapsed: true });
      expect([1, 2, 3, 4, 5].map(jumpTo)).toEqual(["f", "d", "b", "e", "c"]);
      expect(jumpTo(6)).toBe("c");
    });

    it("cmd+shift+a is unchanged by collapsing: only the waiting threads", () => {
      useUiStore.setState({ workingCollapsed: true });
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
        const sel = useUiStore.getState().selection;
        seen.push(sel.kind === "session" ? sel.id : "");
      }
      expect(seen).toEqual(["d", "e", "d"]);
    });
  });

  it("text fields consume command chords", () => {
    press(input, { key: "t", code: "KeyT", metaKey: true });
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("command chords run outside the terminal", () => {
    const e = press(outside, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    // Quiet: the new bottom panel tab is the feedback, not a "created terminal" toast.
    expect(runCommandForResult).toHaveBeenCalledWith("terminal.new", {}, expect.objectContaining({ quiet: true }));
  });

  it("commands with required args open the palette prompt instead of running", () => {
    press(outside, { key: "n", code: "KeyN", metaKey: true, altKey: true });
    expect(runCommandForResult).not.toHaveBeenCalled();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, commandName: "worktree.create", page: "commands" });
  });

  it("session.new's chord opens the project picker, even where the daemon lists it unavailable", async () => {
    const e = press(terminal, { key: "n", code: "KeyN", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(runCommandForResult).not.toHaveBeenCalled();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, page: "projects", commandName: null });
  });

  it("cmd+1..9 belong to the open project picker", () => {
    useUiStore.setState({ palette: { open: true, query: "", commandName: null, page: "projects", returnTo: "content" }, selection: { kind: "none" } });
    const e = press(outside, { key: "1", code: "Digit1", metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "none" });
  });

  it("cmd+b toggles the sidebar", () => {
    press(outside, { key: "b", code: "KeyB", metaKey: true });
    expect(useUiStore.getState().sidebarVisible).toBe(false);
    press(terminal, { key: "b", code: "KeyB", metaKey: true });
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });
});

describe("Run in… presentation (session.run-in)", () => {
  beforeEach(() => {
    useUiStore.setState({ palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" } });
  });

  it("opens the member picker for a workspace thread", async () => {
    useSessionsStore.setState({ byId: { s1: session("s1", { workspaceId: "w-1" }) }, order: ["s1"] });
    expect(openRunInPicker("s1")).toBe(true);
    await Promise.resolve();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, page: "runin", sessionId: "s1" });
  });

  it("is not offered for a project thread or an unknown one", async () => {
    useSessionsStore.setState({ byId: { s1: session("s1") }, order: ["s1"] });
    expect(openRunInPicker("s1")).toBe(false);
    expect(openRunInPicker("nope")).toBe(false);
    expect(openRunInPicker("")).toBe(false);
    await Promise.resolve();
    expect(useUiStore.getState().palette.open).toBe(false);
  });
});

describe("a bare-key command chord", () => {
  let pane: HTMLElement;
  let prompt: HTMLElement;
  let sidebar: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML =
      '<nav id="side" tabindex="0"></nav><section id="pane" data-region="content" tabindex="-1"><div id="prompt" data-keys-local tabindex="-1"></div></section>';
    pane = document.getElementById("pane") as HTMLElement;
    prompt = document.getElementById("prompt") as HTMLElement;
    sidebar = document.getElementById("side") as HTMLElement;
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    useUiStore.setState({ palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" }, selection: { kind: "session", id: "s-r" } });
    // No shipped command binds a bare key (thread.interrupt dropped Escape); a stand-in
    // exercises the rule.
    useCommandsStore.setState({ commands: [cmd({ name: "demo.bare", keybindings: ["escape"] }), cmd({ name: "thread.interrupt" })] });
    useSessionsStore.setState({ byId: { "s-r": session("s-r", { status: "busy" }) }, order: ["s-r"] });
    useCommandsStore.setState({ contextKey: contextKey(getUiContext()) });
    runCommandForResult.mockClear();
  });

  afterEach(() => {
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
  });

  const escape = { key: "Escape", code: "Escape" };

  it("fires in the content pane", () => {
    expect(press(pane, escape).defaultPrevented).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledWith("demo.bare", {}, expect.anything());
  });

  it.each<[string, () => HTMLElement]>([
    ["outside the content pane (lists, dialogs)", () => sidebar],
    ["inside an element with its own keys (a docked prompt)", () => prompt],
  ])("leaves the key alone %s", (_name, target) => {
    expect(press(target(), escape).defaultPrevented).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("fires from a composer button (not the prompt's text)", () => {
    pane.insertAdjacentHTML("beforeend", '<div data-chord-yield><button id="picker" type="button"></button></div>');
    expect(press(document.getElementById("picker") as HTMLElement, escape).defaultPrevented).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledWith("demo.bare", {}, expect.anything());
  });

  it("never interrupts a working thread on Escape", () => {
    useCommandsStore.setState({ commands: [cmd({ name: "thread.interrupt" })] });
    expect(press(pane, escape).defaultPrevented).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("modified chords keep firing anywhere", () => {
    expect(chordFires("cmd+t", sidebar)).toBe(true);
    expect(chordFires("escape", sidebar)).toBe(false);
    expect(chordFires("shift+escape", pane)).toBe(true);
  });
});
