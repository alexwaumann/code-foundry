/**
 * The Themes page (theme.pick, docs/notes/theme-engine-4-picker.md): which slot it edits,
 * the theme previewed in its gallery, and the pairing hint after an Apply. The preview is
 * page state only: the window keeps the applied theme (lib/theme.ts) until Apply writes the
 * slot's setting through theme.set-dark / theme.set-light. Closing the page drops it.
 * The user's own themes (docs/notes/user-themes.md) list first; Customise copies a theme
 * into them (theme.duplicate) and Delete removes one (theme.delete).
 */
import { toast } from "sonner";
import { create } from "zustand";
import { effectiveScheme, themeSlots, type ColorScheme, type ThemePreference } from "@/lib/theme";
import { subscribeUserThemes, themeById, themesFor } from "@/themes";
import { runCommandForResult } from "./commands";
import { leaveEditor, markFreshCopy, stopEditing, useThemeEditorStore } from "./themeEditor";

export type ThemeSlot = ColorScheme;

/** After an Apply: the theme's companion in the other scheme, offered for that slot. */
export interface PairHint {
  /** The slot the hint would fill (the other scheme). */
  readonly slot: ThemeSlot;
  readonly themeId: string;
  /** The theme just applied (named in the sentence). */
  readonly fromId: string;
}

interface ThemePickerState {
  /** The slot whose themes the list shows and Apply writes. */
  slot: ThemeSlot;
  /** The previewed theme; null previews the slot's current theme. */
  preview: string | null;
  query: string;
  hint: PairHint | null;
  /** The page to go back to on close (opened from Settings → Appearance). */
  returnTo: "settings" | null;
  /** An Apply is in flight. */
  applying: boolean;
}

const initial = (slot: ThemeSlot, returnTo: "settings" | null): ThemePickerState => ({ slot, preview: null, query: "", hint: null, returnTo, applying: false });

export const useThemePickerStore = create<ThemePickerState>()(() => initial("dark", null));

/** Resets the page for a fresh visit: on `slot`, else the slot in use; no preview. */
export function resetThemePicker(slot: ThemeSlot | undefined, returnTo: "settings" | null): void {
  useThemePickerStore.setState(initial(slot ?? effectiveScheme(), returnTo));
}

/** Edits the other slot: the list switches scheme and the preview goes back to that slot's theme. */
export function setPickerSlot(slot: ThemeSlot): void {
  useThemePickerStore.setState((s) => (s.slot === slot ? s : { slot, preview: null, query: "" }));
}

export function setPickerQuery(query: string): void {
  useThemePickerStore.setState({ query });
}

/** Previews a theme of the editing slot's scheme in the gallery; anything else is ignored. */
export function previewTheme(id: string): void {
  const s = useThemePickerStore.getState();
  if (themeById.get(id)?.scheme !== s.slot) return;
  useThemePickerStore.setState({ preview: id === themeSlots()[s.slot] ? null : id });
}

/** "Back to current": the gallery shows the slot's applied theme again. */
export function resetPreview(): void {
  useThemePickerStore.setState({ preview: null });
}

/** The theme the gallery shows: the preview, else the slot's applied theme. */
export function previewedId(s: Pick<ThemePickerState, "slot" | "preview">, slots: { light: string; dark: string }): string {
  // A previewed theme that went away (deleted, or an unsaved Customise copy dropped) shows the slot again.
  return s.preview !== null && themeById.has(s.preview) ? s.preview : slots[s.slot];
}

/** The control bar's line on what the scheme does now. */
export function schemeNote(pref: ThemePreference, scheme: ThemeSlot, showing: string): string {
  if (pref === "system") return `Follows macOS: ${scheme} now, showing ${showing}`;
  return `Always ${pref}, showing ${showing}`;
}

/** Themes of a scheme whose name or id contains every word of the query (case-insensitive): the user's first, then the catalog's. */
export function filterThemes(scheme: ThemeSlot, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return themesFor(scheme).filter((t) => {
    const hay = `${t.name} ${t.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The pairing hint after `id` was applied to its slot, or null when there is nothing to suggest. */
export function pairHintFor(id: string, slots: { light: string; dark: string }): PairHint | null {
  const t = themeById.get(id);
  const pair = t?.pair ? themeById.get(t.pair) : undefined;
  if (!t || !pair || pair.scheme === t.scheme) return null;
  if (slots[pair.scheme] === pair.id) return null;
  return { slot: pair.scheme, themeId: pair.id, fromId: t.id };
}

/** Writes a slot's setting through its command; the window repaints when the snapshot lands. */
async function setSlot(slot: ThemeSlot, id: string): Promise<boolean> {
  return (await runCommandForResult(`theme.set-${slot}`, { theme: id }, { quiet: true })) !== null;
}

/**
 * Apply: writes the previewed theme to the editing slot. Then, if the theme has a companion
 * the other slot does not already use, offers it (never fills it by itself).
 */
export async function applyPreview(): Promise<boolean> {
  const s = useThemePickerStore.getState();
  // A preview of a theme that went away (previewedId shows the slot's again) has nothing to apply.
  if (s.preview === null || s.applying || !themeById.has(s.preview)) return false;
  const id = s.preview;
  useThemePickerStore.setState({ applying: true, hint: null });
  const ok = await setSlot(s.slot, id);
  // The settings snapshot that moves the slot may land after the command returns; the
  // preview is now the applied theme either way.
  useThemePickerStore.setState((cur) => ({
    applying: false,
    preview: ok && cur.preview === id ? null : cur.preview,
    hint: ok ? pairHintFor(id, { ...themeSlots(), [s.slot]: id }) : cur.hint,
  }));
  return ok;
}

/** The hint's button: uses the companion for the other slot. */
export async function acceptPairHint(): Promise<boolean> {
  const hint = useThemePickerStore.getState().hint;
  if (!hint) return false;
  const ok = await setSlot(hint.slot, hint.themeId);
  if (ok) useThemePickerStore.setState({ hint: null });
  return ok;
}

export function dismissPairHint(): void {
  useThemePickerStore.setState({ hint: null });
}

/** Resolves once the theme id is known (a user theme's event may land after its command returns), or false after timeoutMs. */
export function whenTheme(id: string, timeoutMs = 3000): Promise<boolean> {
  if (themeById.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = subscribeUserThemes(() => {
      if (!themeById.has(id)) return;
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
  });
}

/** The id in theme.duplicate's JSON result, or null. */
function copiedId(resultJson: string): string | null {
  try {
    const v: unknown = JSON.parse(resultJson);
    return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;
  } catch {
    return null;
  }
}

/** A Customise is being made (customiseTheme). */
let customising = false;

/**
 * Customise: copies the theme into the user's own (theme.duplicate: "<id>-copy", from the
 * original), previews the copy and opens the editor on it (theme.edit). Applying it is
 * Save's "Use as my … theme now", or the usual Apply once the editor is closed.
 */
export async function customiseTheme(id: string): Promise<string | null> {
  // One copy per gesture: a second click (a double-click) while one is being made does nothing.
  if (customising) return null;
  customising = true;
  try {
    if (!(await leaveEditor())) return null;
    const res = await runCommandForResult("theme.duplicate", { theme: id }, { quiet: true });
    const copy = res ? copiedId(res.resultJson) : null;
    if (!copy) return null;
    if (!(await whenTheme(copy))) return null;
    useThemePickerStore.setState({ query: "" });
    previewTheme(copy);
    // Closed without a save, the copy goes again (stopEditing).
    markFreshCopy(copy);
    await editTheme(copy);
    return copy;
  } finally {
    customising = false;
  }
}

/** Edit (a user row) and Customise: theme.edit, whose ShowView opens the editor (stores/views.ts openThemeEditor). */
export async function editTheme(id: string): Promise<boolean> {
  return (await runCommandForResult("theme.edit", { theme: id }, { quiet: true })) !== null;
}

/**
 * Delete: removes one of the user's themes (theme.delete, which asks first). A slot that
 * used it moves to the theme it was copied from (the daemon says which); a preview of it
 * goes back to the slot's theme.
 */
export async function deleteTheme(id: string): Promise<boolean> {
  const name = themeById.get(id)?.name ?? id;
  const res = await runCommandForResult("theme.delete", { theme: id }, { quiet: true });
  if (!res) return false;
  if (useThemeEditorStore.getState().id === id) stopEditing({ keepCopy: true });
  useThemePickerStore.setState((s) => (s.preview === id ? { preview: null } : s));
  toast.success(`Deleted ${name}`, { description: movedSlots(res.resultJson) });
  return true;
}

/** theme.delete's slots ({ "appearance.theme_dark": id }) as a sentence, or undefined. */
function movedSlots(resultJson: string): string | undefined {
  try {
    const slots = (JSON.parse(resultJson) as { slots?: Record<string, string> }).slots ?? {};
    const words = Object.entries(slots).map(([key, to]) => `the ${key.endsWith("_light") ? "light" : "dark"} theme is ${themeById.get(to)?.name ?? to} now`);
    if (words.length === 0) return undefined;
    const text = words.join("; ");
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  } catch {
    return undefined;
  }
}
