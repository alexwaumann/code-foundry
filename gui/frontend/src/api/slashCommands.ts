/**
 * A running thread's slash commands (docs/notes/slash-commands-1-daemon.md) mapped to view
 * models. Generated types stay in src/api. Claude reports them at its handshake and
 * again whenever they change; the daemon drops the ones the app replaces or that mean
 * nothing over stream-json, and ThreadService.Watch carries the list (the snapshot's
 * `commands`, then `commands` events), so the composer reads it from the thread store.
 * Empty: the thread is not running (or the daemon predates the list).
 */
import type { SlashCommand } from "@/gen/codefoundry/v1/thread_pb";

export interface SlashCommandView {
  /** What follows "/" ("compact", "anthropic-skills:pdf"); unique in a list. */
  name: string;
  /** Claude's description; may be a skill's whole paragraph. A project skill's ends in " (project)". */
  description: string;
  /** Shown after the name ("[interval] [prompt]"); "" for none. */
  argumentHint: string;
  /** Other names that run it ("/cost" runs usage). */
  aliases: readonly string[];
  /** Claude Code's own (bundled skills included); false for a user, project or plugin skill or command. */
  builtin: boolean;
}

export function toSlashCommandViews(list: readonly SlashCommand[]): SlashCommandView[] {
  return list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: [...c.aliases], builtin: c.builtin }));
}

function sameCommand(a: SlashCommandView, b: SlashCommandView): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.argumentHint === b.argumentHint &&
    a.builtin === b.builtin &&
    a.aliases.length === b.aliases.length &&
    a.aliases.every((x, i) => x === b.aliases[i])
  );
}

/** `next`, or `prev` when it is the same list: an unchanged list keeps its identity (narrow selectors). */
export function shareCommands(prev: readonly SlashCommandView[], next: readonly SlashCommandView[]): readonly SlashCommandView[] {
  return prev.length === next.length && prev.every((c, i) => sameCommand(c, next[i] as SlashCommandView)) ? prev : next;
}
