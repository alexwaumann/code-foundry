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
      { chord: "cmd+1", title: "Jump to item 1" },
      { chord: "cmd+2", title: "Jump to item 2" },
    ];
    const commands = [
      cmd({ name: "session.new", title: "New Session", category: "Session", keybindings: ["cmd+n"] }),
      cmd({ name: "session.list", title: "List Sessions", category: "Session" }),
      cmd({ name: "terminal.new", title: "New Terminal", category: "Terminal", keybindings: ["cmd+t"], available: false }),
      cmd({ name: "view.help", title: "Help", category: "View", keybindings: ["cmd+/"] }),
    ];
    expect(helpSections(commands, local)).toEqual([
      {
        title: "App",
        items: [
          { keys: ["⌘K", "⇧⌘P"], label: "Command palette", available: true },
          { keys: ["⌘1–9"], label: "Jump to item 1–9", available: true },
        ],
      },
      { title: "Session", items: [{ keys: ["⌘N"], label: "New Session", command: "session.new", available: true }] },
      { title: "Terminal", items: [{ keys: ["⌘T"], label: "New Terminal", command: "terminal.new", available: false }] },
      { title: "View", items: [{ keys: ["⌘/"], label: "Help", command: "view.help", available: true }] },
    ]);
  });
});
