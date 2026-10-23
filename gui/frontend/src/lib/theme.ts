import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { isOutdatedDaemon } from "@/api/errors";
import { errorMessage, isUnreachable } from "@/api/stream";
import { publishTheme, type PublishedTheme } from "@/api/ui";
import { useHealthStore } from "@/stores/health";
import { DEFAULT_DARK, DEFAULT_LIGHT, subscribeUserThemes, themeById, type Theme } from "@/themes";

export type ColorScheme = "dark" | "light";

/** appearance.theme: follow macOS, or force one scheme. */
export type ThemePreference = "system" | "dark" | "light";

const query = "(prefers-color-scheme: light)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

let preference: ThemePreference = "system";
const listeners = new Set<() => void>();

/**
 * The last applied preference and slots, kept in localStorage so a launch paints the
 * user's theme before the daemon's settings arrive: index.html's inline script applies it
 * to <html> before the stylesheet paints, and this module starts from it. The daemon's
 * snapshot (stores/settings.ts) then confirms or replaces it. WebKit's localStorage is
 * per user, not per CODE_FOUNDRY_HOME: a scratch home's launch writes it too.
 */
export const THEME_STORAGE_KEY = "cf.theme";

interface StoredTheme {
  scheme?: unknown;
  light?: unknown;
  dark?: unknown;
}

function readStored(): StoredTheme {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ scheme: preference, light: slots.light, dark: slots.dark }));
  } catch {
    // No storage (Node) or a full quota: the next launch paints the defaults until settings load.
  }
}

/** Dark unless the system explicitly prefers light. */
export function systemScheme(): ColorScheme {
  return media()?.matches ? "light" : "dark";
}

/** The scheme in effect: the preference, or the system's when it is "system". */
export function effectiveScheme(): ColorScheme {
  return preference === "system" ? systemScheme() : preference;
}

/** appearance.theme as last set. */
export function themePreference(): ThemePreference {
  return preference;
}

/** Sets appearance.theme; every useColorScheme and the document follow. */
export function setThemePreference(p: ThemePreference): void {
  if (p === preference) return;
  preference = p;
  persist();
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

/**
 * Calls cb after every change to the active theme's inputs: the preference, the slots,
 * or the macOS appearance. Returns an unsubscribe.
 */
export function onThemeChange(cb: () => void): () => void {
  return subscribe(cb);
}

/** Follows the theme preference and, for "system", the macOS appearance live. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, effectiveScheme, () => "dark");
}

/** The theme id used for each scheme (Settings fills them; GitHub Dark and Light by default). */
export interface ThemeSlots {
  readonly light: string;
  readonly dark: string;
}

const DEFAULT_SLOTS: ThemeSlots = { light: DEFAULT_LIGHT, dark: DEFAULT_DARK };
let slots: ThemeSlots = DEFAULT_SLOTS;
/**
 * The ids the settings asked for, before validSlot: a user theme the GUI does not know
 * yet (its list arrives on the events stream, maybe after the settings) shows the
 * default until it does, then itself (setUserThemes re-resolves).
 */
let wanted: { light?: string; dark?: string } = {};

/** A slot's id if it names a theme of that scheme, else the scheme's default. */
function validSlot(id: string | undefined, scheme: ColorScheme): string {
  const theme = id === undefined ? undefined : themeById.get(id);
  return theme?.scheme === scheme ? theme.id : DEFAULT_SLOTS[scheme];
}

function resolveWanted(): void {
  const light = validSlot(wanted.light, "light");
  const dark = validSlot(wanted.dark, "dark");
  if (light === slots.light && dark === slots.dark) return;
  slots = { light, dark };
  persist();
  for (const l of listeners) l();
}

/**
 * Sets the light and dark theme slots. An id that is unknown, or a theme of the other
 * scheme, falls back to that slot's default (github-light / github-dark) until a user
 * theme with that id arrives; a missing key keeps the slot as it is.
 */
export function setThemeSlots(next: { light?: string; dark?: string }): void {
  wanted = { light: "light" in next ? next.light : wanted.light, dark: "dark" in next ? next.dark : wanted.dark };
  resolveWanted();
}

// Start from the last applied theme (THEME_STORAGE_KEY); anything unusable is the default.
{
  const stored = readStored();
  if (stored.scheme === "system" || stored.scheme === "dark" || stored.scheme === "light") preference = stored.scheme;
  wanted = {
    light: typeof stored.light === "string" ? stored.light : undefined,
    dark: typeof stored.dark === "string" ? stored.dark : undefined,
  };
  slots = { light: validSlot(wanted.light, "light"), dark: validSlot(wanted.dark, "dark") };
}

// A user theme that arrives (or goes, or changes) may be a slot's: resolve again, and
// tell the subscribers when the active theme's colours changed with it.
subscribeUserThemes(() => {
  const before = slots;
  resolveWanted();
  if (slots === before) {
    // Same ids, but a user theme's file may have changed under one of them.
    for (const l of listeners) l();
  }
});

export function themeSlots(): ThemeSlots {
  return slots;
}

/** The current slots; re-renders when either changes. */
export function useThemeSlots(): ThemeSlots {
  return useSyncExternalStore(subscribe, themeSlots, () => DEFAULT_SLOTS);
}

/** The theme in effect: the slot of the effective scheme. */
export function activeTheme(): Theme {
  const scheme = effectiveScheme();
  const theme = themeById.get(slots[scheme]) ?? themeById.get(DEFAULT_SLOTS[scheme]);
  if (!theme) throw new Error(`theme ${slots[scheme]} is not in the catalog`);
  return theme;
}

/** The theme in effect; follows the scheme preference, macOS and the slots. */
export function useActiveTheme(): Theme {
  return useSyncExternalStore(subscribe, activeTheme, activeTheme);
}

/**
 * The active theme's resolved slots: every `--cf-*`, `--terminal-*`, `--syn-*` and `--sh-*`
 * name and its value (`#rrggbb`, or `#rrggbbaa` for tints), as <html> carries them. The
 * same object until the active theme changes. This is the map to hand to anything outside
 * the document that should paint in the theme (a frame's tokens stylesheet).
 */
export function activeThemeSlots(): Readonly<Record<string, string>> {
  return activeTheme().slots;
}

/** activeThemeSlots(); re-renders when the active theme changes. */
export function useActiveThemeSlots(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, activeThemeSlots, activeThemeSlots);
}

/**
 * Calls cb with the resolved slots now and after every change of the active theme (not on
 * a preference or slot change that leaves it the same). Returns an unsubscribe.
 */
export function subscribeThemeSlots(cb: (slots: Readonly<Record<string, string>>) => void): () => void {
  let last = activeThemeSlots();
  cb(last);
  return subscribe(() => {
    const next = activeThemeSlots();
    if (next === last) return;
    last = next;
    cb(next);
  });
}

/**
 * The active theme's id and slots as last applied, for index.html's inline script: it sets
 * them on <html> before the stylesheet paints, when the stored id is the theme it picks.
 */
export const THEME_SLOTS_STORAGE_KEY = "cf.theme.slots";

function persistSlots(id: string, slots: Readonly<Record<string, string>>): void {
  try {
    localStorage.setItem(THEME_SLOTS_STORAGE_KEY, JSON.stringify({ id, vars: slots }));
  } catch {
    // No storage: the first frame of the next launch is the window's background colour.
  }
}

/**
 * Keeps <html> in sync with the active theme: its resolved slots as inline CSS variables
 * (index.css aliases every component name to them), `data-theme` (the id, for tests and
 * selectors), the `dark` class and color-scheme from the theme's own scheme. This is the
 * one place the document's colours change.
 */
export function syncDocumentScheme(): () => void {
  let applied: readonly string[] = [];
  const apply = () => {
    const theme = activeTheme();
    const root = document.documentElement;
    const slots = theme.slots;
    for (const name of applied) if (!(name in slots)) root.style.removeProperty(name);
    for (const [name, value] of Object.entries(slots)) root.style.setProperty(name, value);
    applied = Object.keys(slots);
    root.dataset.theme = theme.id;
    root.classList.toggle("dark", theme.scheme === "dark");
    root.style.colorScheme = theme.scheme;
    persistSlots(theme.id, slots);
  };
  apply();
  return subscribe(apply);
}

/** The active theme as the daemon serves it to frames (GET /cf/theme.css, theme.json). */
export function publishedTheme(): PublishedTheme {
  const t = activeTheme();
  return { id: t.id, scheme: t.scheme, vars: t.slots };
}

/**
 * What an HTML preview's frame is posted on load and on every theme change
 * (docs/notes/theme-css-route.md): `{ type: "cf:theme", id, scheme, vars }`, vars being
 * every resolved slot (`--cf-*`, `--terminal-*`, `--syn-*`, `--sh-*`). A page that wants
 * live updates listens for it; /cf/theme.css already gives it the theme on load.
 */
export interface ThemeFrameMessage extends PublishedTheme {
  type: "cf:theme";
}

export function themeFrameMessage(): ThemeFrameMessage {
  return { type: "cf:theme", ...publishedTheme() };
}

/**
 * Calls cb whenever the GUI reaches a daemon: the first good ping, a restarted daemon (a
 * new pid), and a recovery after a failed ping (the publish that failed meanwhile).
 */
export function onDaemonConnect(cb: () => void): () => void {
  let pid: number | null = null;
  return useHealthStore.subscribe((s) => {
    const next = s.status === "ok" ? (s.health?.pid ?? null) : null;
    if (next !== null && next !== pid) cb();
    pid = next;
  });
}

/**
 * Keeps the daemon's copy of the theme current (UiService.PublishTheme): on start, on
 * every (re)connect and after every change of the active theme, debounced so a burst (the
 * Themes page's arrow keys) sends once. With several windows the last writer wins: the
 * theme is one per user. Every failure is logged; the next connect publishes again. A
 * refusal (the daemon's InvalidArgument: a theme it cannot serve) is also a toast, once
 * per run (reportPublishFailure); an unreachable daemon or one older than the RPC is not,
 * since it serves its last theme or the defaults and the reconnect retries.
 */
const publishedListeners = new Set<() => void>();

let publishFailureShown = false;

/** Logs a failed publish and, the first time one is refused this run, says so in a toast. */
export function reportPublishFailure(err: unknown): void {
  console.warn("theme publish", err);
  if (publishFailureShown || isUnreachable(err) || isOutdatedDaemon(err)) return;
  publishFailureShown = true;
  toast.error("Theme could not be published to pages", { description: `${errorMessage(err)}. Pages keep the last theme the daemon had.` });
}

/** Lets the next refusal toast again (tests). */
export function resetPublishFailureForTest(): void {
  publishFailureShown = false;
}

/**
 * Calls `cb` each time the daemon has the theme (a PublishTheme answered), so
 * `/cf/theme.css` serves it from then on. A preview frame reloads on it when the theme
 * changed since it loaded (HtmlFrame): a page that only links the stylesheet repaints too.
 */
export function onThemePublished(cb: () => void): () => void {
  publishedListeners.add(cb);
  return () => {
    publishedListeners.delete(cb);
  };
}

export function startThemePublish(publish: (t: PublishedTheme) => Promise<void> = publishTheme, onConnect: (cb: () => void) => () => void = onDaemonConnect, debounceMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    timer = undefined;
    publish(publishedTheme()).then(
      () => {
        for (const cb of [...publishedListeners]) cb();
      },
      (err: unknown) => {
        // Retried on the next connect (onConnect).
        reportPublishFailure(err);
      },
    );
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(send, debounceMs);
  };
  const stopSlots = subscribeThemeSlots(schedule);
  const stopConnect = onConnect(schedule);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    stopSlots();
    stopConnect();
  };
}
