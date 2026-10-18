/**
 * The bridge from the app's themes to @pierre/diffs (docs/notes/file-viewer-2-code-foundation.md).
 * The library highlights with Shiki, so each app theme becomes a Shiki theme built from the
 * catalog's values: the pane as the editor background, the seven syntax colours thread.css
 * declares (`--syn-*`) on TextMate scopes, and the status colours as the diff's added,
 * deleted and modified. Code in a diff or a file then reads like the thread's own fenced
 * blocks (lib/highlight.ts) in every theme. A theme is registered on first use, under
 * `cf-<id>`; nothing is shipped as theme JSON.
 */
import { useMemo } from "react";
import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";
import type { Theme } from "@/themes";
import { useActiveTheme } from "./theme";

/** The library's theme name for an app theme. */
export function codeThemeName(id: string): string {
  return `cf-${id}`;
}

type Syn = "--syn-fg" | "--syn-kw" | "--syn-fn" | "--syn-type" | "--syn-str" | "--syn-com" | "--syn-num";

/**
 * TextMate scopes to the syntax variable they take, the lowlight classes' mapping in
 * thread.css (keyword, title/function, type, string, comment, number) in scope terms.
 * Shiki picks the most specific matching selector, so `keyword.operator` stays plain while
 * `keyword` is coloured.
 */
const SCOPES: readonly (readonly [Syn, readonly string[], string?])[] = [
  ["--syn-fg", ["variable", "punctuation", "meta.embedded", "keyword.operator", "variable.parameter", "support.variable"]],
  ["--syn-com", ["comment", "punctuation.definition.comment", "string.comment"], "italic"],
  ["--syn-kw", ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "markup.heading", "entity.name.section"]],
  ["--syn-fn", ["entity.name.function", "support.function", "meta.function-call.generic", "entity.other.attribute-name", "markup.bold"]],
  ["--syn-type", ["entity.name.type", "entity.name.class", "entity.name.tag", "support.type", "support.class", "entity.other.inherited-class"]],
  ["--syn-str", ["string", "punctuation.definition.string", "string.regexp", "markup.raw", "markup.inline.raw", "markup.inserted"]],
  ["--syn-num", ["constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant", "markup.list"]],
];

function hex(theme: Theme, name: string): string {
  const v = theme.vars[name];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`theme ${theme.id} has no ${name}`);
  return v;
}

/** The Shiki theme for an app theme (pure: the catalog's hex values, no DOM). */
export function codeThemeOf(theme: Theme): ThemeRegistration {
  const fg = hex(theme, "--syn-fg");
  return {
    name: codeThemeName(theme.id),
    type: theme.scheme,
    fg,
    bg: hex(theme, "--pane"),
    colors: {
      "editor.background": hex(theme, "--pane"),
      "editor.foreground": fg,
      // Read by the library for the diff's tints and bars (getHighlighterThemeStyles).
      "gitDecoration.addedResourceForeground": hex(theme, "--success"),
      "gitDecoration.deletedResourceForeground": hex(theme, "--destructive"),
      "gitDecoration.modifiedResourceForeground": hex(theme, "--info"),
    },
    tokenColors: SCOPES.map(([v, scope, fontStyle]) => ({
      scope: [...scope],
      settings: { foreground: hex(theme, v), ...(fontStyle ? { fontStyle } : {}) },
    })),
  };
}

const registered = new Set<string>();

/** Registers the theme with the library once; returns its name. */
export function ensureCodeTheme(theme: Theme): string {
  const name = codeThemeName(theme.id);
  if (!registered.has(name)) {
    registered.add(name);
    const t = codeThemeOf(theme);
    registerCustomTheme(name, () => Promise.resolve(t));
  }
  return name;
}

export interface CodeThemeOptions {
  theme: string;
  themeType: "dark" | "light";
}

/** The library's theme options for the active app theme; changes (and re-renders) with it. */
export function useCodeTheme(): CodeThemeOptions {
  const theme = useActiveTheme();
  return useMemo(() => ({ theme: ensureCodeTheme(theme), themeType: theme.scheme }), [theme]);
}
