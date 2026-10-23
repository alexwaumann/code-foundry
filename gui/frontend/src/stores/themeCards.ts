/**
 * The actions of a theme a thread saved (docs/notes/theme-model-flow.md): the thread's
 * theme card and the "<name> applied to dark" toast both offer Undo and Edit (theme.edit,
 * the Themes page's editor on it); a card saved without applying offers Apply
 * (theme.set-<scheme>); and the Themes page's Ask the model starts the thread (theme.ask).
 *
 * Undo has one rule, the daemon's too (docs/notes/theme-fuzz-daemon.md): it puts back what
 * the slot showed immediately before that save, either another theme (theme.set-<scheme>)
 * or, when the save replaced the colours of the theme the slot already showed, that
 * version of the file (theme.restore). It is offered only while the slot still shows this
 * card's colours; it reads "Undone" once the slot is back on what it put back, and is
 * disabled when that is gone (the theme deleted, the version no longer kept).
 */
import { toast } from "sonner";
import { themeById, type ThemeFile, type ThemeScheme } from "@/themes";
import { runCommandForResult } from "./commands";
import { getUiContext } from "./context";
import { useSettingsStore } from "./settings";
import { editTheme } from "./themePicker";
import { useThemesStore } from "./themes";

/** Puts a scheme's slot on `id`. False when the command failed (it toasts why). */
async function setSlot(scheme: ThemeScheme, id: string): Promise<boolean> {
  return (await runCommandForResult(`theme.set-${scheme}`, { theme: id }, { quiet: true })) !== null;
}

/** Puts a scheme's slot on a theme a thread saved without applying (the card's Apply). */
export const applySavedTheme = setSlot;

/** Opens the Themes page's editor on one of the user's themes. */
export function editSavedTheme(id: string): Promise<boolean> {
  return editTheme(id);
}

/** What a card's (or its toast's) Undo puts back: another theme, or a version of its own. */
export interface ThemeUndoTarget {
  scheme: ThemeScheme;
  /** The theme the card saved. */
  id: string;
  /** What the slot showed before the save: another theme's id, or `id` with `version`. */
  previous: string;
  /** With previous = id: the version of the file the save replaced. */
  version: string;
  /** The daemon found nothing to put back when it made the card. */
  gone?: boolean;
}

/** The Undo button's state, and its tooltip. */
export type ThemeUndoState =
  | { kind: "none" }
  | { kind: "hidden" }
  | { kind: "undo"; tip: string }
  | { kind: "gone"; tip: string }
  | { kind: "undone"; tip: string };

/** What the undo rule reads of the app: a theme by id (with its version) and the versions kept of one. */
export interface ThemeLookup {
  theme: (id: string) => { name: string; version?: string; scheme: ThemeScheme; base: ThemeFile["base"]; overrides?: ThemeFile["overrides"] } | undefined;
  history: (id: string) => readonly string[];
}

/** The app's themes and kept versions. */
export const appThemes: ThemeLookup = {
  theme: (id) => themeById.get(id),
  history: (id) => useThemesStore.getState().history[id] ?? [],
};

/** Paints the same: scheme, base and pins (name, pair, from and created_by do not count). */
function samePaint(a: Pick<ThemeFile, "scheme" | "base" | "overrides">, b: Pick<ThemeFile, "scheme" | "base" | "overrides">): boolean {
  const key = (f: Pick<ThemeFile, "scheme" | "base" | "overrides">) => JSON.stringify([f.scheme, f.base, Object.entries(f.overrides ?? {}).sort()]);
  return key(a) === key(b);
}

/**
 * The card's Undo for the file it saved (`saved`, null for a toast, which knows only the
 * id), with the slot showing `slot` now.
 */
export function themeUndoState(t: ThemeUndoTarget, saved: ThemeFile | null, slot: string | undefined, look: ThemeLookup = appThemes): ThemeUndoState {
  if (!t.previous) return { kind: "none" };
  const own = t.previous === t.id;
  const current = look.theme(t.id);
  const name = current?.name ?? t.id;
  const previousName = own ? name : (look.theme(t.previous)?.name ?? t.previous);
  if (own ? slot === t.id && current?.version === t.version : slot === t.previous) {
    return { kind: "undone", tip: own ? `${name} has its previous colours again` : `The ${t.scheme} theme is ${previousName} again` };
  }
  // Only while the slot shows this card's colours: Undo on an old card would replace what
  // the user (or a later save) chose since.
  if (slot !== t.id || !current || (saved && !samePaint(current, saved))) return { kind: "hidden" };
  const there = !t.gone && (own ? current.version === t.version || look.history(t.id).includes(t.version) : look.theme(t.previous) !== undefined);
  if (!there) return { kind: "gone", tip: own ? `The previous colours of ${name} are no longer kept` : `${previousName} was deleted` };
  return { kind: "undo", tip: own ? "Undo restores the previous colours" : `Back to ${previousName}` };
}

/** Runs an Undo: the slot back on the previous theme, or the replaced version back. */
export async function undoTheme(t: ThemeUndoTarget): Promise<boolean> {
  if (t.previous === t.id) return (await runCommandForResult("theme.restore", { theme: t.id, version: t.version }, { quiet: true })) !== null;
  return setSlot(t.scheme, t.previous);
}

/**
 * A toast's Undo ("theme-undo:<scheme>:<id>:<previous>[:<version>]"): the card's rule
 * with the slot as it is now; when it no longer applies, a note instead of a change.
 */
export function undoFromLink(target: string): void {
  const [scheme, id, previous, version = ""] = target.split(":");
  if ((scheme !== "dark" && scheme !== "light") || !id || !previous) return;
  const t: ThemeUndoTarget = { scheme, id, previous, version };
  const state = themeUndoState(t, null, useSettingsStore.getState().snapshot?.values[`appearance.theme_${scheme}`]);
  switch (state.kind) {
    case "undo":
      void undoTheme(t);
      return;
    case "gone":
    case "undone":
      toast.info(state.tip);
      return;
    default:
      toast.info(`Nothing to undo: the ${scheme} theme has changed since`);
  }
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
