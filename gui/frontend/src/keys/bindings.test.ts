import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { registerFileFindHost, useFileFindStore, type FileFindHost } from "@/stores/fileFind";
import { registerTerminalFindHost, useTerminalFindStore } from "@/stores/terminalFind";
import { useThreadFindStore } from "@/stores/threadFind";
import { useSubagentViewStore } from "@/stores/subagentView";
import { useThreadsStore } from "@/stores/threads";
import { HOME, useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { resetNeeds, useNeedsStore } from "@/stores/needs";
import { setShellMode } from "@/stores/shellView";
import { EMBER_THREAD, putEmberThread, setEmberEnabled } from "@/test/emberBoard";
import { chordFires, commandBindings, handleKeyDown, inPalette, installKeybindings, isGlobalChord, nextAttention, openRunInPicker } from "./bindings";

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
    naming: false,
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
    pendingMove: null,
    setup: null,
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    savedAtMs: null,
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
    busyTool: "",
    backgroundShells: [],
    backgroundWakePending: false,
    retry: null,
    createdBy: "",
    createdByName: "",
    brief: "",
    labels: [],
    report: null,
    budgetUsd: 0,
    flags: [],
    ...over,
  };
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/**
 * The File tab's editor as the document has it: a contenteditable in a shadow root, whose
 * host is all `e.target` shows a listener outside it.
 */
function codeEditor(): { host: HTMLElement; content: HTMLElement; find: HTMLInputElement } {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-code-editor", "");
  const host = document.createElement("div");
  wrap.append(host);
  const root = host.attachShadow({ mode: "open" });
  const content = document.createElement("div");
  content.contentEditable = "true";
  content.setAttribute("contenteditable", "true");
  const find = document.createElement("input");
  root.append(content, find);
  document.body.append(wrap);
  return { host, content, find };
}

describe("keys in the File tab's code editor", () => {
  const presses = (el: Element, key: string, code: string, mods: KeyboardEventInit = {}) => press(el, { key, code, composed: true, ...mods });
  let installed: () => void;
  let editor: ReturnType<typeof codeEditor>;

  beforeEach(() => {
    installed = installKeybindings();
    editor = codeEditor();
    useCommandsStore.setState({
      commands: [
        cmd({ name: "thread.find", keybindings: ["cmd+f"] }),
        cmd({ name: "thread.find.next", keybindings: ["cmd+g"] }),
        cmd({ name: "view.back", keybindings: ["cmd+["] }),
        cmd({ name: "view.help", keybindings: ["cmd+/"] }),
        cmd({ name: "file.save", keybindings: ["cmd+s"] }),
        cmd({ name: "x.open", keybindings: ["cmd+j"] }),
        cmd({ name: "x.bare", keybindings: ["f"] }),
      ],
      contextKey: contextKey(getUiContext()),
    });
    runCommandForResult.mockClear();
  });

  afterEach(() => {
    installed();
    document.body.replaceChildren();
    useCommandsStore.setState({ commands: [] });
  });

  it.each([
    ["cmd+F, the editor's find", "f", "KeyF"],
    ["cmd+G, its find again", "g", "KeyG"],
    ["cmd+[, its outdent", "[", "BracketLeft"],
    ["cmd+/, its comment toggle", "/", "Slash"],
    ["cmd+A, its select all", "a", "KeyA"],
    ["cmd+Z, its undo", "z", "KeyZ"],
    ["cmd+V, its paste", "v", "KeyV"],
  ])("%s stays with it", (_name, key, code) => {
    const e = presses(editor.content, key, code, { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("a bare key is text, even one a command binds", () => {
    const e = presses(editor.content, "f", "KeyF");
    expect(e.defaultPrevented).toBe(false);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("F2 and Escape are the editor's too", () => {
    expect(presses(editor.content, "F2", "F2").defaultPrevented).toBe(false);
    expect(presses(editor.content, "Escape", "Escape").defaultPrevented).toBe(false);
  });

  it("a chord bound to a command goes through, as in a thread's prompt", () => {
    const e = presses(editor.content, "j", "KeyJ", { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledWith("x.open", {}, expect.anything());
  });

  it("cmd+S is handled there, and never asks the daemon: the window saves", () => {
    const e = presses(editor.content, "s", "KeyS", { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("cmd+S in a thread's prompt is the prompt's: its history picker's scope, not a save", () => {
    const prompt = document.createElement("div");
    prompt.setAttribute("data-chord-yield", "");
    prompt.setAttribute("contenteditable", "true");
    document.body.append(prompt);
    expect(press(prompt, { key: "s", code: "KeyS", metaKey: true }).defaultPrevented).toBe(false);
    expect(press(prompt, { key: "j", code: "KeyJ", metaKey: true }).defaultPrevented).toBe(true);
  });

  it("its find field is the same", () => {
    expect(presses(editor.find, "f", "KeyF", { metaKey: true }).defaultPrevented).toBe(false);
    expect(presses(editor.find, "s", "KeyS", { metaKey: true }).defaultPrevented).toBe(true);
  });

  it("outside the editor, cmd+F is still the app's", () => {
    expect(press(document.body, { key: "f", code: "KeyF", metaKey: true }).defaultPrevented).toBe(true);
  });
});

describe("file.save in the palette", () => {
  it("is listed only over a tab that is editing", () => {
    expect(inPalette(cmd({ name: "file.save" }))).toBe(false);
  });
});

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

  it("a subagent view unbinds the commands it disables at once, and leaving it binds them again (same command list)", () => {
    const commands = [cmd({ name: "thread.rename", keybindings: ["cmd+r"] })];
    expect(commandBindings(commands).get("cmd+r")?.name).toBe("thread.rename");
    useSubagentViewStore.setState({ viewing: { threadId: "s-1", runId: "r-1" } });
    try {
      expect(commandBindings(commands).has("cmd+r")).toBe(false);
    } finally {
      useSubagentViewStore.setState({ viewing: null });
    }
    expect(commandBindings(commands).get("cmd+r")?.name).toBe("thread.rename");
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
    // The window draws its layout: the key table's verbs (cmd+t) are presented (shell/keyPresenters.ts).
    setShellMode("shell");
  });

  afterEach(() => {
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
    setShellMode("waiting");
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
      expect(runCommandForResult).toHaveBeenCalledWith("terminal.new-free", {}, expect.objectContaining({ quiet: true }));
    });
  });

  it("thread prompt focus before the first list: a cmd chord waits for it (cmd+t as the window opens on the composer); an editing chord does not", async () => {
    document.body.insertAdjacentHTML("beforeend", '<div data-chord-yield><div id="pr" contenteditable="true"></div></div>');
    const prompt = document.getElementById("pr") as HTMLElement;
    const commands = useCommandsStore.getState().commands;
    useCommandsStore.setState({ commands: [], contextKey: null });
    relist.run = () => {
      useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext()) });
    };
    expect(press(prompt, { key: "Backspace", code: "Backspace", metaKey: true }).defaultPrevented).toBe(false);
    expect(useCommandsStore.getState().contextKey).toBeNull();
    const e = press(prompt, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(runCommandForResult).toHaveBeenCalledWith("terminal.new-free", {}, expect.objectContaining({ quiet: true }));
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
      expect(runCommandForResult).toHaveBeenCalledWith("terminal.new-free", {}, expect.objectContaining({ quiet: true }));
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

  describe("cmd+shift+a in the window shell: the popup of the next thread that needs the user", () => {
    beforeEach(() => {
      setShellMode("shell");
      resetNeeds();
    });
    afterEach(() => {
      setShellMode("waiting");
      resetNeeds();
    });

    it("opens the popups in the Needs you order (most recent ask first), wrapping, and selects nothing", () => {
      useThreadsStore.setState({
        byId: {
          a: thread("a", { status: "attention", statusReason: "permission: Bash ls", statusChangedAtMs: 10 }),
          b: thread("b"),
          c: thread("c", { status: "attention", statusReason: "question: Which?", statusChangedAtMs: 20 }),
          d: thread("d", { status: "attention", statusReason: "finished", statusChangedAtMs: 30 }),
        },
        order: ["a", "b", "c", "d"],
      });
      const before = useUiStore.getState().selection;
      const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
      const seen: (string | null)[] = [];
      for (let i = 0; i < 3; i++) {
        jump();
        seen.push(useNeedsStore.getState().popup);
      }
      // d finished a turn: Active's, not Needs you's.
      expect(seen).toEqual(["c", "a", "c"]);
      expect(useUiStore.getState().selection).toEqual(before);
    });

    it("goes to Ember's chat first while Ember waits on the user, then the popups, and back to Ember", () => {
      setEmberEnabled(true);
      // A finished turn is Ember's "reply not seen yet": it counts for Ember (stores/ember.ts emberAttentionId).
      putEmberThread({ status: "attention", statusReason: "finished" }, [
        thread("a", { status: "attention", statusReason: "permission: Bash ls", statusChangedAtMs: 10 }),
        thread("c", { status: "attention", statusReason: "question: Which?", statusChangedAtMs: 20 }),
      ]);
      const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
      jump();
      expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: EMBER_THREAD });
      expect(useNeedsStore.getState().popup).toBeNull();
      jump();
      expect(useNeedsStore.getState().popup).toBe("c");
      jump();
      expect(useNeedsStore.getState().popup).toBe("a");
      jump();
      // Back to Ember: the popup closes and its chat is selected.
      expect(useNeedsStore.getState().popup).toBeNull();
      expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: EMBER_THREAD });
      setEmberEnabled(false);
      jump();
      expect(useNeedsStore.getState().popup).toBe("c");
    });

    it("before the window's first draw (the first-load import) it asks for the popup all the same", () => {
      setShellMode("waiting");
      useThreadsStore.setState({ byId: { a: thread("a", { status: "attention", statusReason: "permission: Bash ls", statusChangedAtMs: 10 }) }, order: ["a"] });
      press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
      expect(useNeedsStore.getState().popup).toBe("a");
    });

    it("does nothing visible when no thread needs the user", () => {
      useThreadsStore.setState({ byId: { b: thread("b") }, order: ["b"] });
      const before = useUiStore.getState().selection;
      press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
      expect(useNeedsStore.getState().popup).toBeNull();
      expect(useUiStore.getState().selection).toEqual(before);
      expect(nextAttention()).toBe(false);
    });
  });

  describe("cmd+1..9 follow the sidebar's groups", () => {
    // Creation order a..f: the sidebar shows d (question) under Needs you, then f (pinned, busy),
    // b (interrupted), e (finished), c (idle), then under Working: a (busy) (lib/shellSections.ts).
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

    it("expanded: Needs you, then pinned, errors, finished, idle, working", () => {
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["d", "f", "b", "e", "c", "a"]);
    });

    it("a stopped idle thread sorts with the idle ones; a starting one keeps a saved finished turn, or is Working once busy", () => {
      // An MCP check starts e without a message: it still waits on the user (never in Working).
      useThreadsStore.setState((s) => ({
        byId: { ...s.byId, c: thread("c", { state: "disconnected", status: "idle" }), e: thread("e", { state: "starting", status: "attention", statusReason: "finished" }) },
      }));
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["d", "f", "b", "e", "c", "a"]);
      // A message starts it: the daemon says busy at once.
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, e: thread("e", { state: "starting", status: "busy", statusReason: "working" }) } }));
      expect([1, 2, 3, 4, 5, 6].map(jumpTo)).toEqual(["d", "f", "b", "c", "e", "a"]);
    });

    it("collapsed: the hidden Working rows are skipped (cmd+6 does nothing)", () => {
      useUiStore.setState({ workingCollapsed: true });
      expect([1, 2, 3, 4, 5].map(jumpTo)).toEqual(["d", "f", "b", "e", "c"]);
      expect(jumpTo(6)).toBe("c");
    });

  });

  describe("cmd+shift+[ / cmd+shift+] step through the sidebar order", () => {
    // The same sidebar as cmd+1..9's: d, f, b, e, c, then under Working: a.
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
      expect([1, 2, 3, 4, 5, 6, 7].map(() => step(1))).toEqual(["d", "f", "b", "e", "c", "a", "d"]);
      expect(runCommandForResult).not.toHaveBeenCalled();
    });

    it("previous from HOME selects the last row, then walks up and wraps", () => {
      expect([1, 2, 3, 4, 5, 6, 7].map(() => step(-1))).toEqual(["a", "c", "e", "b", "f", "d", "a"]);
    });

    it("rows of a collapsed section do not count; a thread in one starts like a page", () => {
      useUiStore.setState({ workingCollapsed: true, selection: { kind: "thread", id: "c" } });
      expect(step(1)).toBe("d");
      expect(step(-1)).toBe("c");
      useUiStore.setState({ selection: { kind: "thread", id: "a" } });
      expect(step(-1)).toBe("c");
    });

    it("a hidden thread selected starts from its creator's row, and is never a stop", () => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, g: thread("g", { createdBy: "d" }) }, order: [...s.order, "g"] }));
      useUiStore.setState({ selection: { kind: "thread", id: "g" } });
      expect(step(1)).toBe("f");
      expect(step(-1)).toBe("d");
      expect(step(1)).toBe("f");
    });

    it("does nothing with no rows", () => {
      useThreadsStore.setState({ byId: {}, order: [] });
      expect(step(1)).toBe("compose");
      expect(step(-1)).toBe("compose");
    });

    it("works from a focused shell", () => {
      expect(step(1, terminal)).toBe("d");
      expect(step(1, terminal)).toBe("f");
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
    useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    const e = press(input, init);
    expect(e.defaultPrevented).toBe(leaves);
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

  it("search.open's cmd+shift+f leaves a text field (a find bar, a settings search) and opens the Find dialog", async () => {
    useCommandsStore.setState((s) => ({ commands: [...s.commands, cmd({ name: "search.open", keybindings: ["cmd+shift+f"] })] }));
    input.focus();
    const e = press(input, { key: "f", code: "KeyF", metaKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, page: "search" });
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("view.back's chord does not leave the palette's input", () => {
    useCommandsStore.setState((s) => ({ commands: [...s.commands, cmd({ name: "view.back", keybindings: ["cmd+["] })] }));
    useUiStore.setState({ palette: { open: true, query: "", commandName: null, page: "commands", returnTo: "content" }, selection: { kind: "view", name: "projects" } });
    expect(press(input, { key: "[", code: "BracketLeft", metaKey: true }).defaultPrevented).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "projects" });
  });

  it("command chords run outside the terminal", () => {
    const e = press(outside, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    // The key table's cmd+t (shell/keyPresenters.ts): with no thread, a free terminal. Quiet: the new tab is the feedback.
    expect(runCommandForResult).toHaveBeenCalledWith("terminal.new-free", {}, expect.objectContaining({ quiet: true }));
  });

  it("cmd+t runs where the daemon lists terminal.new unavailable (no thread, no checkout): a free terminal", () => {
    useCommandsStore.setState((s) => ({ commands: s.commands.map((c) => (c.name === "terminal.new" ? { ...c, available: false } : c)) }));
    const e = press(outside, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledWith("terminal.new-free", {}, expect.objectContaining({ quiet: true }));
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

  it("thread.move.open only for a thread the move picker takes (not archived or moving)", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
    const home = { projectId: "", worktreePath: "/Users/me" };
    for (const [over, want] of [
      [{}, true],
      [{ archivedAtMs: 1 }, false],
      [{ pendingMove: { projectId: "web", workspaceId: "", worktreePath: "", branch: "" } }, false],
    ] as const) {
      useThreadsStore.setState({ byId: { s1: thread("s1", { ...home, ...over }) }, order: ["s1"] });
      expect(inPalette(cmd({ name: "thread.move.open" }))).toBe(want);
    }
  });
});

describe("the find chords, by where the keyboard is", () => {
  const FIND = [cmd({ name: "thread.find", keybindings: ["cmd+f"] }), cmd({ name: "thread.find.next", keybindings: ["cmd+g"] }), cmd({ name: "thread.find.previous", keybindings: ["cmd+shift+g"] })];
  // Unavailable, as the list says until the debounced re-list catches a focus change up.
  const TERMINAL = [cmd({ name: "terminal.find", keybindings: ["cmd+f"], available: false }), cmd({ name: "terminal.find.next", keybindings: ["cmd+g"], available: false }), cmd({ name: "terminal.find.previous", keybindings: ["cmd+shift+g"], available: false })];
  let installed: () => void;
  let release: () => void;
  let step: ReturnType<typeof vi.fn<(dir: 1 | -1) => void>>;

  const list = (...commands: CommandView[]) => {
    useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext()) });
  };
  const terminalOpen = () => "t1" in useTerminalFindStore.getState().byTerminal;
  const threadOpen = () => "s-1" in useThreadFindStore.getState().byThread;

  /** A terminal's box with xterm's textarea, which has the keyboard. */
  function shell(): HTMLTextAreaElement {
    const box = document.createElement("div");
    box.dataset.terminalBox = "t1";
    const host = document.createElement("div");
    host.dataset.terminalHost = "";
    const textarea = document.createElement("textarea");
    host.append(textarea);
    box.append(host);
    document.body.append(box);
    textarea.focus();
    return textarea;
  }

  function prompt(): HTMLElement {
    const el = document.createElement("div");
    el.dataset.chordYield = "";
    el.setAttribute("contenteditable", "true");
    document.body.append(el);
    el.focus();
    return el;
  }

  beforeEach(() => {
    installed = installKeybindings();
    step = vi.fn<(dir: 1 | -1) => void>();
    release = registerTerminalFindHost("t1", { step });
    useThreadsStore.setState({ byId: { "s-1": thread("s-1") }, order: ["s-1"] });
    useUiStore.getState().select({ kind: "thread", id: "s-1" });
    list(...FIND, ...TERMINAL);
  });

  afterEach(() => {
    installed();
    release();
    document.body.replaceChildren();
    useTerminalFindStore.setState({ byTerminal: {} });
    useThreadFindStore.setState({ byThread: {} });
    useThreadsStore.setState({ byId: {}, order: [] });
    useUiStore.getState().select(HOME);
  });

  it("cmd+f in a terminal opens its bar, not the thread's", () => {
    const e = press(shell(), { key: "f", code: "KeyF", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(terminalOpen()).toBe(true);
    expect(threadOpen()).toBe(false);
  });

  it("cmd+f in the thread's prompt stays the thread's, with a terminal on screen", () => {
    shell();
    press(prompt(), { key: "f", code: "KeyF", metaKey: true });
    expect(threadOpen()).toBe(true);
    expect(terminalOpen()).toBe(false);
  });

  it("cmd+g and cmd+shift+g step the terminal's open bar, and open a closed one", () => {
    const textarea = shell();
    press(textarea, { key: "g", code: "KeyG", metaKey: true });
    expect(terminalOpen()).toBe(true);
    expect(step).not.toHaveBeenCalled();
    press(textarea, { key: "g", code: "KeyG", metaKey: true });
    press(textarea, { key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(step.mock.calls).toEqual([[1], [-1]]);
  });

  it("xterm leaves the chords to the app", () => {
    expect(isGlobalChord("cmd+f")).toBe(true);
    expect(isGlobalChord("cmd+shift+g")).toBe(true);
  });

  it("the keymap does not give a shared chord to the terminal's command", () => {
    const bindings = commandBindings(useCommandsStore.getState().commands);
    expect(bindings.get("cmd+f")?.name).toBe("thread.find");
    list(...FIND, ...TERMINAL.map((c) => ({ ...c, available: true })), cmd({ name: "thread.find.first" }));
    expect(commandBindings(useCommandsStore.getState().commands).get("cmd+f")?.name).toBe("thread.find");
  });

  it("a rebound terminal.find moves with the user, and cmd+f in a terminal falls back to the thread's", () => {
    list(...FIND, cmd({ name: "terminal.find", keybindings: ["cmd+shift+y"] }));
    const textarea = shell();
    press(textarea, { key: "f", code: "KeyF", metaKey: true });
    expect(threadOpen()).toBe(true);
    expect(terminalOpen()).toBe(false);
    press(textarea, { key: "y", code: "KeyY", metaKey: true, shiftKey: true });
    expect(terminalOpen()).toBe(true);
  });

  it("a rebound thread.find leaves cmd+f to the terminal, and to nothing outside it", () => {
    list(cmd({ name: "thread.find", keybindings: ["cmd+shift+y"] }), ...TERMINAL);
    press(prompt(), { key: "f", code: "KeyF", metaKey: true });
    expect(threadOpen()).toBe(false);
    expect(terminalOpen()).toBe(false);
    press(shell(), { key: "f", code: "KeyF", metaKey: true });
    expect(terminalOpen()).toBe(true);
  });

  it("a user's ctrl chord for it beats the program; a bare key never does", () => {
    list(...FIND, cmd({ name: "terminal.find", keybindings: ["ctrl+f"] }), cmd({ name: "terminal.find.next", keybindings: ["n"] }));
    expect(isGlobalChord("ctrl+f")).toBe(true);
    expect(isGlobalChord("n")).toBe(false);
    const textarea = shell();
    expect(press(textarea, { key: "n", code: "KeyN" }).defaultPrevented).toBe(false);
    expect(terminalOpen()).toBe(false);
    press(textarea, { key: "f", code: "KeyF", ctrlKey: true });
    expect(terminalOpen()).toBe(true);
  });

  it("the palette open keeps the chord from a terminal", () => {
    useUiStore.getState().openPalette();
    press(shell(), { key: "f", code: "KeyF", metaKey: true });
    expect(terminalOpen()).toBe(false);
    useUiStore.getState().closePalette();
  });
});

describe("the find chords in a File tab", () => {
  const FIND = [cmd({ name: "thread.find", keybindings: ["cmd+f"] }), cmd({ name: "thread.find.next", keybindings: ["cmd+g"] }), cmd({ name: "thread.find.previous", keybindings: ["cmd+shift+g"] })];
  const FILE = [cmd({ name: "file.search", keybindings: ["cmd+f"] }), cmd({ name: "file.search.next", keybindings: ["cmd+g"] }), cmd({ name: "file.search.previous", keybindings: ["cmd+shift+g"] })];
  let installed: () => void;
  let release: () => void;
  let step: ReturnType<typeof vi.fn<(dir: 1 | -1) => void>>;
  let handOff: ReturnType<typeof vi.fn<(query: string) => void>>;
  let host: FileFindHost;
  let tab: HTMLElement;

  const list = (...commands: CommandView[]) => {
    useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext()) });
  };
  const fileOpen = () => "k1" in useFileFindStore.getState().byTab;
  const threadOpen = () => "s-1" in useThreadFindStore.getState().byThread;

  /** The tab's code box, which takes the keyboard on a click (view mode). */
  function code(): HTMLElement {
    const el = document.createElement("div");
    el.tabIndex = -1;
    tab.append(el);
    el.focus();
    return el;
  }

  /** The tab's editor (edit mode): a contenteditable in a shadow root, and the library's find and replace panel. */
  function editor(): { host: HTMLElement; content: HTMLElement; panelField: HTMLInputElement } {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-code-editor", "k");
    const h = document.createElement("div");
    wrap.append(h);
    const root = h.attachShadow({ mode: "open" });
    const content = document.createElement("div");
    content.setAttribute("contenteditable", "true");
    const panel = document.createElement("div");
    panel.setAttribute("data-search-panel", "");
    const panelField = document.createElement("input");
    panel.append(panelField);
    root.append(content, panel);
    tab.append(wrap);
    return { host: h, content, panelField };
  }

  beforeEach(() => {
    installed = installKeybindings();
    tab = document.createElement("div");
    tab.setAttribute("data-file-find-box", "");
    document.body.append(tab);
    step = vi.fn<(dir: 1 | -1) => void>();
    handOff = vi.fn<(query: string) => void>();
    host = { root: tab, step, opened: vi.fn(), finish: vi.fn(), handOff };
    release = registerFileFindHost("k1", host);
    useThreadsStore.setState({ byId: { "s-1": thread("s-1") }, order: ["s-1"] });
    useUiStore.getState().select({ kind: "thread", id: "s-1" });
    list(...FIND, ...FILE);
  });

  afterEach(() => {
    installed();
    release();
    document.body.replaceChildren();
    useFileFindStore.setState({ byTab: {} });
    useThreadFindStore.setState({ byThread: {} });
    useThreadsStore.setState({ byId: {}, order: [] });
    useUiStore.getState().select(HOME);
  });

  it("cmd+f on the tab's code opens its bar, not the thread's", () => {
    const e = press(code(), { key: "f", code: "KeyF", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(fileOpen()).toBe(true);
    expect(threadOpen()).toBe(false);
  });

  it("cmd+f in the thread's prompt stays the thread's, with the tab on screen", () => {
    const el = document.createElement("div");
    el.dataset.chordYield = "";
    el.setAttribute("contenteditable", "true");
    document.body.append(el);
    press(el, { key: "f", code: "KeyF", metaKey: true });
    expect(threadOpen()).toBe(true);
    expect(fileOpen()).toBe(false);
  });

  it("cmd+g and cmd+shift+g step the tab's open bar, and open a closed one", () => {
    const el = code();
    press(el, { key: "g", code: "KeyG", metaKey: true });
    expect(fileOpen()).toBe(true);
    expect(step).not.toHaveBeenCalled();
    press(el, { key: "g", code: "KeyG", metaKey: true });
    press(el, { key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(step.mock.calls).toEqual([[1], [-1]]);
  });

  it("in the editor, cmd+f is the tab's bar and never reaches the library's own find", () => {
    const { content } = editor();
    const e = press(content, { key: "f", code: "KeyF", metaKey: true, composed: true });
    expect(e.defaultPrevented).toBe(true);
    expect(fileOpen()).toBe(true);
  });

  it("in the library's find and replace panel its chords stay its own", () => {
    const { panelField } = editor();
    const e = press(panelField, { key: "f", code: "KeyF", metaKey: true, composed: true });
    expect(e.defaultPrevented).toBe(false);
    expect(fileOpen()).toBe(false);
  });

  it("cmd+alt+f in the editor is the library's replace, which takes the bar's query", () => {
    const { content } = editor();
    useFileFindStore.setState({ byTab: { k1: { query: "value", focusSeq: 1, focusedSeq: 1, current: null, revealSeq: 0, index: -1, total: 0, capped: false, draft: null } } });
    const e = press(content, { key: "f", code: "KeyF", metaKey: true, altKey: true, composed: true });
    expect(e.defaultPrevented).toBe(false);
    expect(handOff).toHaveBeenCalledWith("value");
    expect(fileOpen()).toBe(false);
  });

  it("a text field of the tab's own keeps its keys (the bar handles its chords itself)", () => {
    const field = document.createElement("input");
    tab.append(field);
    field.focus();
    press(field, { key: "f", code: "KeyF", metaKey: true });
    expect(fileOpen()).toBe(false);
    expect(threadOpen()).toBe(false);
  });

  it("a File tab that cannot search (an HTML page, an image) leaves cmd+f to the thread", () => {
    release();
    const el = code();
    press(el, { key: "f", code: "KeyF", metaKey: true });
    expect(fileOpen()).toBe(false);
    expect(threadOpen()).toBe(true);
    release = registerFileFindHost("k1", host);
  });

  it("the keymap does not give the shared chord to the file's command", () => {
    expect(commandBindings(useCommandsStore.getState().commands).get("cmd+f")?.name).toBe("thread.find");
  });

  it("a rebound file.search moves with the user: cmd+f in the tab is the thread's again", () => {
    list(...FIND, cmd({ name: "file.search", keybindings: ["cmd+shift+y"] }));
    const el = code();
    press(el, { key: "f", code: "KeyF", metaKey: true });
    expect(threadOpen()).toBe(true);
    expect(fileOpen()).toBe(false);
    press(el, { key: "y", code: "KeyY", metaKey: true, shiftKey: true });
    expect(fileOpen()).toBe(true);
  });

  it("the palette lists the file's verbs only with a tab that can search on screen", () => {
    expect(inPalette(FILE[0] as CommandView)).toBe(true);
    release();
    expect(inPalette(FILE[0] as CommandView)).toBe(false);
    release = registerFileFindHost("k1", host);
  });

  it("the palette open keeps the chord from the tab", () => {
    useUiStore.getState().openPalette();
    press(code(), { key: "f", code: "KeyF", metaKey: true });
    expect(fileOpen()).toBe(false);
    useUiStore.getState().closePalette();
  });
});
