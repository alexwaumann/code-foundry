import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { SessionView } from "@/api/session";
import { useCommandsStore } from "@/stores/commands";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { commandBindings, handleKeyDown, isGlobalChord } from "./bindings";

const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));

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
    terminalId: `t-${id}`,
    state: "connected",
    status: "idle",
    createdAtMs: 1,
    lastActivityAtMs: null,
    exitCode: 0,
    disconnectReason: "",
    lastError: "",
    parentId: "",
    permissionMode: "",
    baseRef: "",
    createdWorktree: false,
    workspaceId: "",
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
    useUiStore.setState({ selection: { kind: "none" }, renamingSessionId: null });
    runCommand.mockClear();
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
    expect(runCommand).toHaveBeenCalledTimes(runs ? 1 : 0);
    expect(isGlobalChord(init.metaKey ? `cmd+${init.key}` : `ctrl+${init.key}`)).toBe(runs);
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

  it("cmd+shift+a cycles through sessions needing attention", () => {
    useSessionsStore.setState({
      byId: { a: session("a", { status: "attention" }), b: session("b"), c: session("c", { status: "attention" }) },
      order: ["a", "b", "c"],
    });
    const jump = () => press(terminal, { key: "a", code: "KeyA", metaKey: true, shiftKey: true });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "a" });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "c" });
    jump();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "a" });
  });

  it("text fields consume command chords", () => {
    press(input, { key: "t", code: "KeyT", metaKey: true });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("command chords run outside the terminal", () => {
    const e = press(outside, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(runCommand).toHaveBeenCalledWith("terminal.new");
  });

  it("commands with required args open the palette prompt instead of running", () => {
    press(outside, { key: "n", code: "KeyN", metaKey: true, altKey: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, commandName: "worktree.create", page: "commands" });
  });

  it("session.new's chord opens the project picker, even where the daemon lists it unavailable", async () => {
    const e = press(terminal, { key: "n", code: "KeyN", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(runCommand).not.toHaveBeenCalled();
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
