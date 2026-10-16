/**
 * The Themes page (theme.pick, docs/notes/theme-engine-4-picker.md): which slot it edits,
 * the theme previewed in its gallery, and the pairing hint after an Apply. The preview is
 * page state only: the window keeps the applied theme (lib/theme.ts) until Apply writes the
 * slot's setting through theme.set-dark / theme.set-light. Closing the page drops it.
 */
import { create } from "zustand";
import { effectiveScheme, themeSlots, type ColorScheme, type ThemePreference } from "@/lib/theme";
import { themeById, themesFor } from "@/themes";
import { runCommandForResult } from "./commands";

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
  return s.preview ?? slots[s.slot];
}

/** The control bar's line on what the scheme does now. */
export function schemeNote(pref: ThemePreference, scheme: ThemeSlot, showing: string): string {
  if (pref === "system") return `Follows macOS: ${scheme} now, showing ${showing}`;
  return `Always ${pref}, showing ${showing}`;
}

/** Themes of a scheme whose name or id contains every word of the query (case-insensitive). */
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
  if (s.preview === null || s.applying) return false;
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
