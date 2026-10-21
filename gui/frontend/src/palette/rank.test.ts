import { describe, expect, it } from "vitest";
import type { CommandView } from "@/api/command";
import { rankCommands } from "./rank";

function cmd(name: string, title: string, category: string, keybindings: string[] = []): CommandView {
  return { name, title, description: "", category, args: [], keybindings, available: true };
}

// Category order (App, Plugin, Pull Request, View) is the order the palette used to list.
const commands = [
  cmd("app.relaunch", "Relaunch App", "App"),
  cmd("app.echo_path", "Echo Path", "App"),
  cmd("plugin.secret.delete", "Delete Plugin Secret", "Plugin"),
  cmd("pr.refresh", "Refresh Pull Request", "Pull Request"),
  cmd("pr.fix", "Fix Pull Request Findings", "Pull Request"),
  cmd("settings.path", "Settings File Path", "Settings"),
  cmd("view.help", "Keyboard Shortcuts and Help", "View", ["cmd+/"]),
  cmd("view.settings", "Settings", "View", ["cmd+,"]),
  cmd("view.panel.expand", "Expand Side Panel", "View"),
  cmd("view.panel.toggle", "Toggle Side Panel", "View", ["cmd+b"]),
  cmd("view.panel.split", "Split Side Panel", "View", ["cmd+\\"]),
];

describe("rankCommands", () => {
  it.each([
    ["help", "view.help"],
    ["split", "view.panel.split"],
    ["settings", "view.settings"],
    ["relaunch", "app.relaunch"],
    // Ties (every "… Panel" title) go to those with a keybinding, then by title.
    ["panel", "view.panel.split"],
    // The dotted name matches too.
    ["pr.fix", "pr.fix"],
  ])("%s ranks %s first", (query, want) => {
    expect(rankCommands(commands, query)[0]?.name).toBe(want);
  });

  it("ranks bound panel commands above the unbound one", () => {
    expect(rankCommands(commands, "panel").map((c) => c.name)).toEqual(["view.panel.split", "view.panel.toggle", "view.panel.expand"]);
  });

  it("drops commands that do not match", () => {
    expect(rankCommands(commands, "zzz")).toEqual([]);
  });

  it("an empty query keeps every command in order", () => {
    expect(rankCommands(commands, "  ")).toEqual(commands);
  });
});
