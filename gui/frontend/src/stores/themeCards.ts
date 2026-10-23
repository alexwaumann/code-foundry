/**
 * The actions of a theme a thread saved (docs/notes/theme-model-flow.md): the thread's
 * theme card and the "<name> applied to dark" toast both offer Undo (the slot back to the
 * theme it had: theme.set-dark / theme.set-light) and Edit (theme.edit, the Themes page's
 * editor on it), and the Themes page's Ask the model starts the thread (theme.ask).
 */
import type { ThemeScheme } from "@/themes";
import { runCommandForResult } from "./commands";
import { editTheme } from "./themePicker";

/** Puts a scheme's slot back on `id`. False when the command failed (it toasts why). */
export async function undoTheme(scheme: ThemeScheme, id: string): Promise<boolean> {
  return (await runCommandForResult(`theme.set-${scheme}`, { theme: id }, { quiet: true })) !== null;
}

/** Opens the Themes page's editor on one of the user's themes. */
export function editSavedTheme(id: string): Promise<boolean> {
  return editTheme(id);
}

/**
 * Starts a thread that makes the theme described (theme.ask); the daemon focuses it. With
 * `pair`, the thread makes the other scheme's pair of that theme. False when it failed.
 */
export async function askForTheme(description: string, pair?: string): Promise<boolean> {
  const args: Record<string, string> = {};
  if (description.trim()) args.description = description.trim();
  if (pair) args.pair = pair;
  return (await runCommandForResult("theme.ask", args, { quiet: true })) !== null;
}
