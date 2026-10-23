/**
 * The actions of a theme a thread saved (docs/notes/theme-model-flow.md): the thread's
 * theme card and the "<name> applied to dark" toast both offer Undo (the slot back to the
 * theme it had: theme.set-dark / theme.set-light) and Edit (theme.edit, the Themes page's
 * editor on it); a card saved without applying offers Apply (theme.set-<scheme>); and the
 * Themes page's Ask the model starts the thread (theme.ask).
 */
import type { ThemeScheme } from "@/themes";
import { runCommandForResult } from "./commands";
import { getUiContext } from "./context";
import { editTheme } from "./themePicker";

/** Puts a scheme's slot on `id`. False when the command failed (it toasts why). */
async function setSlot(scheme: ThemeScheme, id: string): Promise<boolean> {
  return (await runCommandForResult(`theme.set-${scheme}`, { theme: id }, { quiet: true })) !== null;
}

/** Puts a scheme's slot back on `id` (the card's and the toast's Undo). */
export const undoTheme = setSlot;

/** Puts a scheme's slot on a theme a thread saved without applying (the card's Apply). */
export const applySavedTheme = setSlot;

/** Opens the Themes page's editor on one of the user's themes. */
export function editSavedTheme(id: string): Promise<boolean> {
  return editTheme(id);
}

/**
 * Starts a thread that makes the theme described (theme.ask); the daemon focuses it. With
 * `pair`, the thread makes the other scheme's pair of that theme. Asked from the Themes page
 * (its active view is "themes"), so the model's first message says where the user is. False
 * when it failed.
 */
export async function askForTheme(description: string, pair?: string): Promise<boolean> {
  const args: Record<string, string> = {};
  if (description.trim()) args.description = description.trim();
  if (pair) args.pair = pair;
  return (await runCommandForResult("theme.ask", args, { quiet: true, ctx: { ...getUiContext(), activeView: THEMES_VIEW } })) !== null;
}

/** The Themes page as a command's active view (the daemon's command.ViewThemes). */
export const THEMES_VIEW = "themes";
