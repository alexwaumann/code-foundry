import { defaultFilter } from "cmdk";
import type { CommandView } from "@/api/command";

// A title match counts most, the dotted name a little less, the category least: "help"
// should find "Keyboard Shortcuts and Help" before a loose subsequence through
// "app.relaunch Relaunch App".
const TITLE = 1;
const NAME = 0.9;
const CATEGORY = 0.5;

/** How well a command matches the query: 0 (no match) to 1, weighting title > name > category. */
export function commandRank(c: CommandView, query: string): number {
  return Math.max(TITLE * defaultFilter(c.title, query), NAME * defaultFilter(c.name, query), CATEGORY * defaultFilter(c.category, query));
}

/**
 * The commands matching query, best first. Ties go to commands with a keybinding (the
 * everyday ones), then by title. cmdk cannot do this itself across groups: its group sort
 * looks for a data-value attribute Command.Group never renders, so results come out in
 * category order and Enter runs whatever early category matched loosely.
 */
export function rankCommands(commands: readonly CommandView[], query: string): CommandView[] {
  const q = query.trim();
  if (!q) return [...commands];
  return commands
    .map((c) => ({ c, score: commandRank(c, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.c.keybindings.length > 0) - Number(a.c.keybindings.length > 0) || a.c.title.localeCompare(b.c.title))
    .map((x) => x.c);
}
