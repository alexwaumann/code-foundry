import { describe, expect, it } from "vitest";
import type { TerminalView } from "@/api/terminal";
import { bridgeSources } from "./bridgeSources";
import { useTerminalsStore } from "./terminals";

const term = (id: string, over: Partial<TerminalView> = {}): TerminalView => ({
  id,
  argv: ["/bin/zsh", "-l"],
  cwd: "/w",
  cols: 80,
  rows: 24,
  title: "",
  state: "running",
  exitCode: 0,
  startedAtMs: 1,
  exitedAtMs: null,
  altScreen: false,
  labels: { kind: "shell", thread: "s-1" },
  liveCwd: "/w/sub",
  foreground: "",
  lastCommand: "",
  ...over,
});

// A page's `terminal` source lists every terminal without what was typed in it: the command
// lines can hold secrets in their arguments, and the daemon's read verbs leave them out for a
// page too (docs/notes/shell-24a-import-moves.md, item 7). The rest is as the app has it.
describe("the bridge's terminal source", () => {
  it.each([
    ["a running command and the last one", { foreground: "deploy --token=s3cr3t", lastCommand: "export KEY=abc" }],
    ["only a last command", { lastCommand: "curl -H 'Authorization: x' https://e.x" }],
    ["at the prompt, nothing run", {}],
  ])("leaves out the command lines: %s", (_what, over) => {
    useTerminalsStore.setState({ byId: { "t-1": term("t-1", over) }, order: ["t-1"], loaded: true });
    const got = bridgeSources.terminal.snapshot?.("s-1") as TerminalView[];
    expect(got).toEqual([term("t-1")]);
    expect(JSON.stringify(got)).not.toMatch(/s3cr3t|KEY=abc|Authorization/);
    // The app's own store is untouched.
    expect(useTerminalsStore.getState().byId["t-1"]).toEqual(term("t-1", over));
  });
});
