import { useSyncExternalStore } from "react";

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

/**
 * The colour theme on <html> (`data-theme`). Only "default" (src/index.css) for now; it is
 * the attribute a theme engine will set, with the `dark` class picking the scheme within it.
 */
export const DEFAULT_THEME = "default";

/**
 * Keeps <html> in sync with the effective scheme: the `dark` class, color-scheme, and
 * `data-theme`. Everything colour-related reads CSS variables those select
 * (src/index.css), so this is the one place the document's colours change.
 */
export function syncDocumentScheme(): () => void {
  const apply = () => {
    const scheme = effectiveScheme();
    const root = document.documentElement;
    root.dataset.theme = DEFAULT_THEME;
    root.classList.toggle("dark", scheme === "dark");
    root.style.colorScheme = scheme;
  };
  apply();
  return subscribe(apply);
}
