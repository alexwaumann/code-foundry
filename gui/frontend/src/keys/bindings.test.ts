import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { useThreadsStore } from "@/stores/threads";
import { HOME, useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { chordFires, commandBindings, handleKeyDown, inPalette, isGlobalChord, openRunInPicker } from "./bindings";

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

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    claudeSessionId: "",
    projectId: "",
    worktreePath: "/src/app",
    name: id,
    autoNamed: false,
    nameProvisional: false,
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
    branch: "",
    projectIds: [],
    checkoutPaths: [],
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
    contextWindow: 0,
    cacheExpiresAtMs: null,
    contextRereadUsd: 0,
    agentsRunning: 0,
    backgroundAgentsRunning: 0,
    backgroundShellsRunning: 0,
    backgroundWakePending: false,
    retry: null,
    createdBy: "",
    createdByName: "",
    brief: "",
    labels: [],
    report: null,
    budgetUsd: 0,
    inSidebar: null,
    flags: [],
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
        cmd({ name: "thread.new", keybindings: ["cmd+n"], available: false, args: [{ name: "model", type: "enum", required: true, description: "", enumValues: ["opus"], defaultValue: "" }] }),
        cmd({ name: "worktree.create", keybindings: ["cmd+alt+n"], args: [{ name: "branch", type: "string", required: true, description: "", enumValues: [], defaultValue: "" }] }),
        cmd({ name: "thread.rename", keybindings: ["cmd+r"], args: [{ name: "name", type: "string", required: true, description: "", enumValues: [], defaultValue: "" }] }),
      ],
    });
    useThreadsStore.setState({ byId: {}, order: [] });
    useUiStore.setState({ selection: { kind: "none" }, renamingThreadId: null, workingCollapsed: false });
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

  it("thread.rename's chord starts the inline rename instead of the palette", () => {
    useThreadsStore.setState({ byId: { s1: thread("s1") }, order: ["s1"] });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
    press(terminal, { key: "r", code: "KeyR", metaKey: true });
    expect(useUiStore.getState().renamingThreadId).toBe("s1");
    expect(useUiStore.getState().palette.open).toBe(false);
  });

  it("F2 renames the selected thread outside the tree", () => {
    useThreadsStore.setState({ byId: { s1: thread("s1") }, order: ["s1"] });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
    press(outside, { key: "F2", code: "F2" });
    expect(useUiStore.getState().renamingThreadId).toBe("s1");
  });

  it("cmd+shift+a cycles through threads needing attention in sidebar order (newest first)", () => {
    useThreadsStore.setState({
      byId: { a: thread("a", { status: "attention" }), b: thread("b"), c: thread("c", { status: "attention" }) },
      order: ["a", "b", "c"],
    });
    const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "c" });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "a" });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "c" });
  });

  it("cmd+shift+a visits prompts before finished turns, as the sidebar lists them", () => {
    useThreadsStore.setState({
      byId: {
        a: thread("a", { status: "attention", statusReason: "finished" }),
        b: thread("b", { status: "attention", statusReason: "question: Which?" }),
        c: thread("c", { status: "attention", statusReason: "finished" }),
        d: thread("d", { status: "error", statusReason: "interrupted" }),
      },
      order: ["a", "b", "c", "d"],
    });
    const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      jump();
      const sel = useUiStore.getState().selection;
      seen.push(sel.kind === "thread" ? sel.id : "");
    }
    expect(seen).toEqual(["b", "c", "a", "b"]);
  });

  describe("cmd+1..9 follow the sidebar's groups", () => {
    // Creation order a..f: the sidebar shows f (pinned, busy), d (question), b (interrupted),
    // e (finished), c (idle), then under Working: a (busy).
    beforeEach(() => {
      useThreadsStore.setState({
        byId: {
          a: thread("a", { status: "busy" }),
          b: thread("b", { state: "disconnected", status: "error", statusReason: "interrupted" }),
          c: thread("c"),
          d: thread("d", { status: "attention", statusReason: "question: Which?" }),
          e: thread("e", { status: "attention", statusReason: "finished" }),
          f: thread("f", { status: "busy", pinned: true }),
        },
        order: ["a", "b", "c", "d", "e", "f"],
      });
    });
    const jumpTo = (n: number) => {
      press(outside, { key: String(n), code: `Digit${String(n)}`, metaKey: true });
      const sel = useUiStore.getState().selection;
      return sel.kind === "thread" ? sel.id : "";
    };

    it("expanded: pinned, prompts, errors, finished, idle, working", () => {
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["f", "d", "b", "e", "c", "a"]);
    });

    it("a stopped idle thread sorts with the idle ones; a starting one keeps a saved finished turn, or is Working once busy", () => {
      // An MCP check starts e without a message: it still waits on the user (never in Working).
      useThreadsStore.setState((s) => ({
        byId: { ...s.byId, c: thread("c", { state: "disconnected", status: "idle" }), e: thread("e", { state: "starting", status: "attention", statusReason: "finished" }) },
      }));
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["f", "d", "b", "e", "c", "a"]);
      // A message starts it: the daemon says busy at once.
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, e: thread("e", { state: "starting", status: "busy", statusReason: "working" }) } }));
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
        seen.push(sel.kind === "thread" ? sel.id : "");
      }
      expect(seen).toEqual(["d", "e", "d"]);
    });
  });

  describe("cmd+shift+[ / cmd+shift+] step through the sidebar order", () => {
    // The same sidebar as cmd+1..9's: f, d, b, e, c, then under Working: a.
    beforeEach(() => {
      useCommandsStore.setState((s) => ({
        commands: [...s.commands, cmd({ name: "thread.previous", keybindings: ["cmd+shift+["] }), cmd({ name: "thread.next", keybindings: ["cmd+shift+]"] })],
      }));
      useThreadsStore.setState({
        byId: {
          a: thread("a", { status: "busy" }),
          b: thread("b", { state: "disconnected", status: "error", statusReason: "interrupted" }),
          c: thread("c"),
          d: thread("d", { status: "attention", statusReason: "question: Which?" }),
          e: thread("e", { status: "attention", statusReason: "finished" }),
          f: thread("f", { status: "busy", pinned: true }),
        },
        order: ["a", "b", "c", "d", "e", "f"],
      });
      useUiStore.setState({ selection: HOME });
    });
    const step = (by: 1 | -1, target: Element = outside) => {
      const e = by === 1 ? press(target, { key: "}", code: "BracketRight", metaKey: true, shiftKey: true }) : press(target, { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
      expect(e.defaultPrevented).toBe(true);
      const sel = useUiStore.getState().selection;
      return sel.kind === "thread" ? sel.id : sel.kind;
    };

    it("next from HOME selects the first row, then walks down and wraps", () => {
      expect([1, 2, 3, 4, 5, 6, 7].map(() => step(1))).toEqual(["f", "d", "b", "e", "c", "a", "f"]);
      expect(runCommandForResult).not.toHaveBeenCalled();
    });

    it("previous from HOME selects the last row, then walks up and wraps", () => {
      expect([1, 2, 3, 4, 5, 6, 7].map(() => step(-1))).toEqual(["a", "c", "e", "b", "d", "f", "a"]);
    });

    it("rows of a collapsed section do not count; a thread in one starts like a page", () => {
      useUiStore.setState({ workingCollapsed: true, selection: { kind: "thread", id: "c" } });
      expect(step(1)).toBe("f");
      expect(step(-1)).toBe("c");
      useUiStore.setState({ selection: { kind: "thread", id: "a" } });
      expect(step(-1)).toBe("c");
    });

    it("a hidden thread selected starts from its creator's row, and is never a stop", () => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, g: thread("g", { createdBy: "d", inSidebar: false }) }, order: [...s.order, "g"] }));
      useUiStore.setState({ selection: { kind: "thread", id: "g" } });
      expect(step(1)).toBe("b");
      expect(step(-1)).toBe("d");
      expect(step(1)).toBe("b");
    });

    it("does nothing with no rows", () => {
      useThreadsStore.setState({ byId: {}, order: [] });
      expect(step(1)).toBe("compose");
      expect(step(-1)).toBe("compose");
    });

    it("works from a focused shell, and lands in the window's history", () => {
      useUiStore.setState({ history: [HOME], historyIndex: 0 });
      expect(step(1, terminal)).toBe("f");
      expect(step(1, terminal)).toBe("d");
      useUiStore.getState().back();
      expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "f" });
    });

    it("a plain text field keeps them (only back and forward leave one)", () => {
      expect(press(input, { key: "}", code: "BracketRight", metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
      expect(useUiStore.getState().selection).toEqual(HOME);
    });
  });

  it("text fields consume command chords", () => {
    press(input, { key: "t", code: "KeyT", metaKey: true });
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it.each<[string, string, KeyboardEventInit & { key: string }, boolean]>([
    ["view.back's cmd+[ leaves a text field (the settings search)", "cmd+[", { key: "[", code: "BracketLeft", metaKey: true }, true],
    ["view.forward's cmd+] leaves a text field", "cmd+]", { key: "]", code: "BracketRight", metaKey: true }, true],
    ["back rebound to cmd+arrowleft stays with the field (line start)", "cmd+arrowleft", { key: "ArrowLeft", code: "ArrowLeft", metaKey: true }, false],
    ["back rebound to alt+[ stays with the field (no cmd)", "alt+[", { key: "[", code: "BracketLeft", altKey: true }, false],
  ])("%s", (_name, chord, init, leaves) => {
    useCommandsStore.setState((s) => ({ commands: [...s.commands, cmd({ name: chord === "cmd+]" ? "view.forward" : "view.back", keybindings: [chord] })] }));
    useUiStore.setState({ selection: { kind: "view", name: "projects" }, history: [HOME, { kind: "view", name: "projects" }], historyIndex: 1 });
    const e = press(input, init);
    expect(e.defaultPrevented).toBe(leaves);
    if (chord === "cmd+[") expect(useUiStore.getState().selection).toEqual(HOME);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("view.settings's cmd+, leaves a text field: the sheet's toggle closes it from its own search", () => {
    useCommandsStore.setState((s) => ({ commands: [...s.commands, cmd({ name: "view.settings", keybindings: ["cmd+,"] })] }));
    useViewsStore.setState({ settingsOpen: true, themesOpen: false, usageOpen: false });
    const e = press(input, { key: ",", code: "Comma", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("view.back's chord does not leave the palette's input", () => {
    useCommandsStore.setState((s) => ({ commands: [...s.commands, cmd({ name: "view.back", keybindings: ["cmd+["] })] }));
    useUiStore.setState({ palette: { open: true, query: "", commandName: null, page: "commands", returnTo: "content" }, selection: { kind: "view", name: "projects" }, history: [HOME, { kind: "view", name: "projects" }], historyIndex: 1 });
    expect(press(input, { key: "[", code: "BracketLeft", metaKey: true }).defaultPrevented).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "projects" });
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

  it("thread.new's chord opens the project picker, even where the daemon lists it unavailable", async () => {
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

describe("Run in… presentation (thread.run-in)", () => {
  beforeEach(() => {
    useUiStore.setState({ palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" } });
  });

  it("opens the member picker for a workspace thread", async () => {
    useThreadsStore.setState({ byId: { s1: thread("s1", { projectId: "web", projectIds: ["web"], workspaceId: "w-1" }) }, order: ["s1"] });
    expect(openRunInPicker("s1")).toBe(true);
    await Promise.resolve();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, page: "runin", threadId: "s1" });
  });

  it("is not offered in a workspace without projects: its folder is the only place", async () => {
    useThreadsStore.setState({ byId: { s1: thread("s1", { projectIds: [], workspaceId: "w-1" }) }, order: ["s1"] });
    expect(openRunInPicker("s1")).toBe(false);
    await Promise.resolve();
    expect(useUiStore.getState().palette.open).toBe(false);
  });

  it("is not offered for a project thread or an unknown one", async () => {
    useThreadsStore.setState({ byId: { s1: thread("s1") }, order: ["s1"] });
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
    useUiStore.setState({ palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" }, selection: { kind: "thread", id: "s-r" } });
    // No shipped command binds a bare key (thread.interrupt dropped Escape); a stand-in
    // exercises the rule.
    useCommandsStore.setState({ commands: [cmd({ name: "demo.bare", keybindings: ["escape"] }), cmd({ name: "thread.interrupt" })] });
    useThreadsStore.setState({ byId: { "s-r": thread("s-r", { status: "busy" }) }, order: ["s-r"] });
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

describe("inPalette", () => {
  it("leaves out a command the daemon marks NoPalette", () => {
    expect(inPalette(cmd({ name: "thread.new" }))).toBe(true);
    expect(inPalette(cmd({ name: "thread.list", noPalette: true }))).toBe(false);
    expect(inPalette(cmd({ name: "ember.status", noPalette: true }))).toBe(false);
  });

  it("leaves out a command that is not startable here", () => {
    expect(inPalette(cmd({ name: "git.push", available: false }))).toBe(false);
  });
});
