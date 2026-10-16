import { useSyncExternalStore } from "react";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById, type Theme } from "@/themes";

export type ColorScheme = "dark" | "light";

/** appearance.theme: follow macOS, or force one scheme. */
export type ThemePreference = "system" | "dark" | "light";

const query = "(prefers-color-scheme: light)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

let preference: ThemePreference = "system";
const listeners = new Set<() => void>();

/** Dark unless the system explicitly prefers light. */
export function systemScheme(): ColorScheme {
  return media()?.matches ? "light" : "dark";
}

/** The scheme in effect: the preference, or the system's when it is "system". */
export function effectiveScheme(): ColorScheme {
  return preference === "system" ? systemScheme() : preference;
}

/** Sets appearance.theme; every useColorScheme and the document follow. */
export function setThemePreference(p: ThemePreference): void {
  if (p === preference) return;
  preference = p;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  const m = media();
  m?.addEventListener("change", cb);
  listeners.add(cb);
  return () => {
    m?.removeEventListener("change", cb);
    listeners.delete(cb);
  };
}

/** Follows the theme preference and, for "system", the macOS appearance live. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, effectiveScheme, () => "dark");
}

/** The theme id used for each scheme (Settings fills them; Catppuccin by default). */
export interface ThemeSlots {
  readonly light: string;
  readonly dark: string;
}

const DEFAULT_SLOTS: ThemeSlots = { light: DEFAULT_LIGHT, dark: DEFAULT_DARK };
let slots: ThemeSlots = DEFAULT_SLOTS;

/** A slot's id if it names a theme of that scheme, else the scheme's default. */
function validSlot(id: string | undefined, scheme: ColorScheme): string {
  const theme = id === undefined ? undefined : themeById.get(id);
  return theme?.scheme === scheme ? theme.id : DEFAULT_SLOTS[scheme];
}

/**
 * Sets the light and dark theme slots. An id that is unknown, or a theme of the other
 * scheme, falls back to that slot's default (catppuccin-latte / catppuccin-mocha); a
 * missing key keeps the slot as it is.
 */
export function setThemeSlots(next: { light?: string; dark?: string }): void {
  const light = "light" in next ? validSlot(next.light, "light") : slots.light;
  const dark = "dark" in next ? validSlot(next.dark, "dark") : slots.dark;
  if (light === slots.light && dark === slots.dark) return;
  slots = { light, dark };
  for (const l of listeners) l();
}

export function themeSlots(): ThemeSlots {
  return slots;
}

/** The current slots; re-renders when either changes. */
export function useThemeSlots(): ThemeSlots {
  return useSyncExternalStore(subscribe, themeSlots, () => DEFAULT_SLOTS);
}

/** The theme in effect: the slot of the effective scheme. */
export function activeTheme(): Theme {
  const id = slots[effectiveScheme()];
  const theme = themeById.get(id);
  if (!theme) throw new Error(`theme ${id} is not in the catalog`);
  return theme;
}

/** The theme in effect; follows the scheme preference, macOS and the slots. */
export function useActiveTheme(): Theme {
  return useSyncExternalStore(subscribe, activeTheme, activeTheme);
}

/**
 * Keeps <html> in sync with the active theme: `data-theme` (its block in
 * src/themes/themes.css), the `dark` class and color-scheme from the theme's own scheme.
 * Everything colour-related reads the CSS variables those select, so this is the one
 * place the document's colours change.
 */
export function syncDocumentScheme(): () => void {
  const apply = () => {
    const theme = activeTheme();
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.classList.toggle("dark", theme.scheme === "dark");
    root.style.colorScheme = theme.scheme;
  };
  apply();
  return subscribe(apply);
}
