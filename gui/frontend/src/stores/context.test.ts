import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalView } from "@/api/terminal";
import { useBottomStore } from "./bottomPanel";
import { deriveContext, getUiContext } from "./context";
import { useReposStore } from "./repos";
import { useSessionsStore } from "./sessions";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

function term(id: string, labels: Record<string, string>): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels };
}

const shell = { kind: "shell", session: "s1", repo: "r1", worktree: "/src/app" };
const closed = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as const };

describe("the bottom panel's shell in the command context", () => {
  beforeEach(() => {
    const list = [term("claude", { session: "s1" }), term("a", shell), term("b", shell)];
    useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
    useReposStore.setState({ byId: {}, order: [] });
    useSessionsStore.setState({ byId: {}, order: [] });
    useBottomStore.setState({ byKey: { "session:s1": { open: true, activeTerminalId: "a" } }, pendingFocus: null, pendingFocusId: null });
    useUiStore.setState({ selection: { kind: "session", id: "s1" }, focus: "bottom", palette: closed });
  });

  it("deriveContext puts the focused shell in activeTerminalId and keeps the rest", () => {
    const sel = { kind: "session", id: "s1" } as const;
    const plain = deriveContext(sel, useTerminalsStore.getState(), useReposStore.getState());
    const focused = deriveContext(sel, useTerminalsStore.getState(), useReposStore.getState(), undefined, "a");
    expect(focused).toEqual({ ...plain, activeTerminalId: "a" });
    expect(focused.activeSessionId).toBe("s1");
  });

  const cases: [string, () => void, string][] = [
    ["keyboard in the bottom panel: its active shell", () => undefined, "a"],
    ["the palette opened from there: still that shell", () => useUiStore.setState({ focus: "palette", palette: { ...closed, open: true, returnTo: "bottom" } }), "a"],
    ["keyboard in the content pane: nothing from the bottom panel", () => useUiStore.setState({ focus: "terminal" }), ""],
    ["the panel closed", () => useBottomStore.setState({ byKey: { "session:s1": { open: false, activeTerminalId: "a" } } }), ""],
  ];
  it.each(cases)("getUiContext: %s", (_name, arrange, want) => {
    arrange();
    expect(getUiContext().activeTerminalId).toBe(want);
    expect(getUiContext().activeSessionId).toBe("s1");
  });

  it("an explicit selection gets that selection's context only", () => {
    expect(getUiContext({ kind: "session", id: "s1" }).activeTerminalId).toBe("");
  });
});
