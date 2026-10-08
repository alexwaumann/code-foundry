import type { CommandView } from "@/api/command";
import type { FocusRegion, Selection } from "@/stores/ui";
import { formatChord } from "./chord";

export interface Hint {
  keys: string;
  label: string;
}

const palette: Hint = { keys: "⌘K", label: "Commands" };
const sidebar: Hint = { keys: "⌘B", label: "Sidebar" };
const jump: Hint = { keys: "⌘1–9", label: "Jump" };

/**
 * Footer hints for what the keyboard does right now. A focused terminal swallows command
 * chords, so only global chords are listed there; elsewhere the available command
 * keybindings for the current context are listed too.
 */
export function hintsFor(focus: FocusRegion, selection: Selection, commands: readonly CommandView[], max = 4): Hint[] {
  if (focus === "palette") {
    return [
      { keys: "↑↓", label: "Select" },
      { keys: "↵", label: "Run" },
      { keys: "⌫", label: "Back" },
      { keys: "Esc", label: "Close" },
    ];
  }
  if (focus === "terminal") {
    return [palette, sidebar, jump, { keys: "⌘C", label: "Copy selection" }, { keys: "⌘+ ⌘−", label: "Font size" }];
  }
  const base: Hint[] =
    focus === "sidebar"
      ? [{ keys: "↑↓", label: "Move" }, { keys: "↵", label: "Open" }, { keys: "←→", label: "Fold" }, palette]
      : [palette, sidebar, ...(selection.kind === "none" ? [jump] : [])];
  const bound = commands
    .filter((c) => c.available && c.keybindings.length > 0)
    .slice(0, max)
    .map((c) => ({ keys: formatChord(c.keybindings[0] ?? ""), label: c.title }));
  return [...base, ...bound];
}
