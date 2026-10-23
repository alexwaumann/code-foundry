/**
 * The colour themes (docs/notes/user-themes.md) as view models: the user's own theme
 * files with their contents, from the EventService theme source (ThemeService.Watch's
 * events; the GUI holds one events stream). The GUI resolves a user theme's slots
 * with the same rules as the catalog's (src/themes); the daemon derives no colour. Saving,
 * copying and deleting are the theme.* commands.
 */
import type { ThemeEvent, ThemeSnapshot, UserTheme } from "@/gen/codefoundry/v1/theme_pb";
import type { ThemeScheme, UserThemeFile } from "@/themes";

/** A file in the themes directory that is not a theme the app can use. */
export interface ThemeFileIssueView {
  file: string;
  message: string;
}

export interface ThemesSnapshotView {
  /** The user's valid themes, by name. */
  user: readonly UserThemeFile[];
  issues: readonly ThemeFileIssueView[];
  /** The themes directory. */
  dir: string;
  version: number;
}

const scheme = (s: string): ThemeScheme | null => (s === "dark" || s === "light" ? s : null);

/** A user theme as a theme file (the catalog's format plus from, createdBy and its path); null for a scheme the GUI does not know. */
export function toUserThemeFile(t: UserTheme): UserThemeFile | null {
  const sc = scheme(t.scheme);
  const b = t.base;
  const term = b?.terminal;
  if (!sc || !b || !term) return null;
  const opt = (v: string) => (v ? v : undefined);
  const overrides = Object.keys(t.overrides).length > 0 ? { ...t.overrides } : undefined;
  return {
    id: t.id,
    name: t.name,
    scheme: sc,
    ...(t.pair ? { pair: t.pair } : {}),
    source: t.source,
    base: {
      canvas: b.canvas,
      surface: b.surface,
      text: b.text,
      accent: b.accent,
      success: b.success,
      warning: b.warning,
      error: b.error,
      info: b.info,
      highlight: b.highlight,
      ...(opt(b.link) ? { link: b.link } : {}),
      terminal: {
        foreground: term.foreground,
        ...(opt(term.cursor) ? { cursor: term.cursor } : {}),
        ...(opt(term.cursorText) ? { cursorText: term.cursorText } : {}),
        ...(opt(term.selection) ? { selection: term.selection } : {}),
        ansi: [...term.ansi],
      },
    },
    ...(overrides ? { overrides } : {}),
    from: t.from,
    createdBy: t.createdBy,
    path: t.path,
  };
}

export function toThemesSnapshotView(s: ThemeSnapshot | undefined): ThemesSnapshotView {
  return {
    user: (s?.user ?? []).map(toUserThemeFile).filter((t): t is UserThemeFile => t !== null),
    issues: (s?.issues ?? []).map((i) => ({ file: i.file, message: i.message })),
    dir: s?.dir ?? "",
    version: Number(s?.version ?? 0n),
  };
}

export function toThemeEventView(e: ThemeEvent): ThemesSnapshotView {
  return toThemesSnapshotView(e.snapshot);
}
