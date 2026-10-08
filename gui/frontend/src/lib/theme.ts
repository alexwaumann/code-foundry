import { useSyncExternalStore } from "react";

export type ColorScheme = "dark" | "light";

const query = "(prefers-color-scheme: light)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** Dark unless the system explicitly prefers light. */
export function systemScheme(): ColorScheme {
  return media()?.matches ? "light" : "dark";
}

function subscribe(cb: () => void): () => void {
  const m = media();
  m?.addEventListener("change", cb);
  return () => m?.removeEventListener("change", cb);
}

/** Follows the macOS appearance live. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, systemScheme, () => "dark");
}

/** Keeps the `dark` class on <html> in sync with the system appearance. */
export function syncDocumentScheme(): () => void {
  const apply = () => {
    document.documentElement.classList.toggle("dark", systemScheme() === "dark");
    document.documentElement.style.colorScheme = systemScheme();
  };
  apply();
  return subscribe(apply);
}
