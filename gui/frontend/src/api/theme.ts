/**
 * The colour themes (docs/notes/user-themes.md) as view models: the user's own theme
 * files with their contents, from the EventService theme source (ThemeService.Watch's
 * events; the GUI holds one events stream). The GUI resolves a user theme's slots
 * with the same rules as the catalog's (src/themes); the daemon derives no colour. Saving,
 * copying and deleting are the theme.* commands.
 */
import type { ThemeEvent, ThemeSnapshot, UserTheme } from "@/gen/codefoundry/v1/theme_pb";
import { readUserThemeFile, type UserThemeFile } from "@/themes";

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

/**
 * A user theme as a theme file (the catalog's format plus from, createdBy and its path),
 * read by the same rules as a curated file (readUserThemeFile: parseThemeFile, user mode);
 * null for one those refuse (a scheme the GUI does not know, a retired slot, ...).
 */
export function toUserThemeFile(t: UserTheme): UserThemeFile | null {
  const b = t.base;
  const term = b?.terminal;
  const opt = (k: string, v: string | undefined) => (v ? { [k]: v } : {});
  const json = {
    id: t.id,
    name: t.name,
    scheme: t.scheme,
    ...opt("pair", t.pair),
    ...opt("from", t.from),
    ...opt("created_by", t.createdBy),
    ...opt("source", t.source),
    base: b && {
      canvas: b.canvas,
      surface: b.surface,
      text: b.text,
      accent: b.accent,
      success: b.success,
      warning: b.warning,
      error: b.error,
      info: b.info,
      highlight: b.highlight,
      ...opt("link", b.link),
      terminal: term && {
        foreground: term.foreground,
        ...opt("cursor", term.cursor),
        ...opt("cursorText", term.cursorText),
        ...opt("selection", term.selection),
        ansi: [...term.ansi],
      },
    },
    ...(Object.keys(t.overrides).length > 0 ? { overrides: { ...t.overrides } } : {}),
  };
  return readUserThemeFile(json, t.path, t.version);
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
