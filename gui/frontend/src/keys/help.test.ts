import { describe, expect, it } from "vitest";
import type { CommandView } from "@/api/command";
import { helpSections } from "./help";

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "c", title: "C", description: "", category: "X", args: [], keybindings: [], available: true, ...over };
}

describe("helpSections", () => {
  it("merges GUI chords, then groups bound commands by category", () => {
    const local = [
      { chord: "cmd+k", title: "Command palette" },
      { chord: "cmd+shift+p", title: "Command palette" },
      { chord: "cmd+1", title: "Jump to thread 1" },
      { chord: "cmd+2", title: "Jump to thread 2" },
    ];
    const commands = [
      cmd({ name: "thread.new", title: "New Thread", category: "Thread", keybindings: ["cmd+n"] }),
      cmd({ name: "thread.list", title: "List Threads", category: "Thread" }),
      cmd({ name: "terminal.new", title: "New Terminal", category: "Terminal", keybindings: ["cmd+t"], available: false }),
      cmd({ name: "view.help", title: "Help", category: "View", keybindings: ["cmd+/"] }),
    ];
    expect(helpSections(commands, local)).toEqual([
      {
        title: "App",
        items: [
          { keys: ["⌘K", "⇧⌘P"], label: "Command palette", available: true },
          { keys: ["⌘1–9"], label: "Jump to thread 1–9", available: true },
        ],
      },
      { title: "Terminal", items: [{ keys: ["⌘T"], label: "New Terminal", command: "terminal.new", available: false }] },
      { title: "Thread", items: [{ keys: ["⌘N"], label: "New Thread", command: "thread.new", available: true }] },
      { title: "View", items: [{ keys: ["⌘/"], label: "Help", command: "view.help", available: true }] },
    ]);
  });
});
