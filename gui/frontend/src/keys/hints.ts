import type { CommandView } from "@/api/command";
import type { FocusRegion, Selection } from "@/stores/ui";
import { formatChord, normalizeChord, terminalYieldable } from "./chord";

export interface Hint {
  keys: string;
  label: string;
}

const palette: Hint = { keys: "⌘K", label: "Commands" };
const sidebar: Hint = { keys: "⌘B", label: "Sidebar" };
const jump: Hint = { keys: "⌘1–9", label: "Jump" };
const attention: Hint = { keys: "⌘⇧A", label: "Needs attention" };

/**
 * Available commands with a keybinding, those for the selected kind of thing first
 * (session.* when a session is selected), each shown with its first chord.
 */
function boundHints(commands: readonly CommandView[], selection: Selection, chordOk: (chord: string) => boolean, max: number): Hint[] {
  const prefix = selection.kind === "session" || selection.kind === "terminal" ? `${selection.kind}.` : null;
  return commands
    .filter((c) => c.available && c.keybindings.some(chordOk))
    .map((c, i) => ({ c, i, rank: prefix && c.name.startsWith(prefix) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, max)
    .map(({ c }) => ({ keys: formatChord(c.keybindings.find(chordOk) ?? ""), label: c.title }));
}

/**
 * Footer hints for what the keyboard does right now. A focused terminal swallows command
 * chords except cmd chords (which it yields to the app), so only those are listed there;
 * elsewhere every available command keybinding for the current context is a candidate.
 */
export function hintsFor(focus: FocusRegion, selection: Selection, commands: readonly CommandView[], max = 4, attentionCount = 0): Hint[] {
  if (focus === "palette") {
    return [
      { keys: "↑↓", label: "Select" },
      { keys: "↵", label: "Run" },
      { keys: "⌫", label: "Back" },
      { keys: "Esc", label: "Close" },
    ];
  }
  const waiting = attentionCount > 0 ? [attention] : [];
  if (focus === "terminal") {
    const yielded = boundHints(commands, selection, (k) => terminalYieldable(normalizeChord(k) ?? k), selection.kind === "session" ? 3 : 2);
    return [palette, ...waiting, ...yielded, sidebar, jump, { keys: "⌘C", label: "Copy selection" }, { keys: "⌘+ ⌘−", label: "Font size" }];
  }
  // F2 always renames inline; list it only when session.rename has no chord of its own.
  const renameBound = commands.some((c) => c.name === "session.rename" && c.available && c.keybindings.length > 0);
  const rename: Hint[] = selection.kind === "session" && !renameBound ? [{ keys: "F2", label: "Rename" }] : [];
  const base: Hint[] =
    focus === "sidebar"
      ? [{ keys: "↑↓", label: "Move" }, { keys: "↵", label: "Open" }, { keys: "←→", label: "Fold" }, palette]
      : [palette, sidebar, ...(selection.kind === "none" ? [jump] : [])];
  return [...base, ...waiting, ...boundHints(commands, selection, () => true, max), ...rename];
}
