import type { CommandView } from "@/api/command";
import { groupByCategory } from "@/palette/args";
import { formatChord } from "./chord";

export interface HelpItem {
  keys: string[];
  label: string;
  /** Command name, for registry commands. */
  command?: string;
  /** False when the command is not available in the current context. */
  available: boolean;
}

export interface HelpSection {
  title: string;
  items: HelpItem[];
}

/** A chord the GUI handles itself (view actions and a few fixed keys). */
export interface LocalChord {
  chord: string;
  title: string;
}

/**
 * Sections for the help overlay: the GUI's own chords first (identical titles merged,
 * so cmd+k and cmd+shift+p share a row and cmd+1..9 is one row), then every registry
 * command with an effective keybinding, grouped by category like the palette.
 */
export function helpSections(commands: readonly CommandView[], local: readonly LocalChord[]): HelpSection[] {
  const app: HelpItem[] = [];
  for (const a of local) {
    let label = a.title;
    let keys = formatChord(a.chord);
    // "Jump to item 3" on cmd+3 -> one "Jump to item 1–9" row on ⌘1–9.
    const numbered = /^(.*) \d$/.exec(a.title);
    if (numbered) {
      label = `${numbered[1] ?? ""} 1–9`;
      keys = keys.replace(/\d$/, "1–9");
    }
    const prev = app.find((i) => i.label === label);
    if (!prev) app.push({ keys: [keys], label, available: true });
    else if (!prev.keys.includes(keys)) prev.keys.push(keys);
  }
  const bound = commands.filter((c) => c.keybindings.length > 0);
  const sections: HelpSection[] = [{ title: "App", items: app }];
  for (const [category, list] of groupByCategory(bound)) {
    sections.push({
      title: category,
      items: list.map((c) => ({ keys: c.keybindings.map(formatChord), label: c.title, command: c.name, available: c.available })),
    });
  }
  return sections;
}
