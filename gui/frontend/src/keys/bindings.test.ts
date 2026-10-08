import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { useUiStore } from "@/stores/ui";
import { commandBindings, handleKeyDown, isGlobalChord } from "./bindings";
import { hintsFor } from "./hints";

const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "c", title: "C", description: "", category: "X", args: [], keybindings: [], available: true, ...over };
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
    useUiStore.setState({ palette: { open: false, query: "", commandName: null, returnTo: "content" }, sidebarVisible: true });
    useCommandsStore.setState({
      commands: [cmd({ name: "terminal.new", keybindings: ["cmd+t"] }), cmd({ name: "session.new", keybindings: ["cmd+n"], args: [{ name: "model", type: "enum", required: true, description: "", enumValues: ["opus"], defaultValue: "" }] })],
    });
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
    expect(isGlobalChord("cmd+t")).toBe(false);
  });

  it("the terminal consumes non-global command chords", () => {
    const e = press(terminal, { key: "t", code: "KeyT", metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
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
    press(outside, { key: "n", code: "KeyN", metaKey: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, commandName: "session.new" });
  });

  it("cmd+b toggles the sidebar", () => {
    press(outside, { key: "b", code: "KeyB", metaKey: true });
    expect(useUiStore.getState().sidebarVisible).toBe(false);
    press(terminal, { key: "b", code: "KeyB", metaKey: true });
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });
});

describe("hintsFor", () => {
  const cmds = [cmd({ title: "New Terminal", keybindings: ["cmd+t"] }), cmd({ title: "Hidden", keybindings: ["cmd+h"], available: false }), cmd({ title: "No key" })];
  it.each([
    ["terminal: only global chords", "terminal" as const, ["⌘K", "⌘B", "⌘1–9", "⌘C", "⌘+ ⌘−"]],
    ["sidebar: navigation + bound commands", "sidebar" as const, ["↑↓", "↵", "←→", "⌘K", "⌘T"]],
    ["content: palette + bound commands", "content" as const, ["⌘K", "⌘B", "⌘1–9", "⌘T"]],
    ["palette", "palette" as const, ["↑↓", "↵", "⌫", "Esc"]],
  ])("%s", (_name, focus, keys) => {
    expect(hintsFor(focus, { kind: "none" }, cmds).map((h) => h.keys)).toEqual(keys);
  });
});
