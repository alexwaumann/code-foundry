import { afterEach, describe, expect, it, vi } from "vitest";
import { activeTheme, setThemePreference, setThemeSlots, themeSlots } from "@/lib/theme";
import { setUserThemes, subscribeUserThemes, themeById, themes, themesFor, USER_THEMES_STORAGE_KEY, userThemes, type UserThemeFile } from ".";

/** A user theme: a curated theme's colours under a new id. */
function userFile(id: string, name: string, from: string, edit: Partial<UserThemeFile> = {}): UserThemeFile {
  const src = themeById.get(from);
  if (!src) throw new Error(from);
  return { id, name, scheme: src.scheme, source: "", base: src.base, from, createdBy: "", path: `/h/themes/${id}.json`, ...edit };
}

afterEach(() => {
  setUserThemes([]);
  setThemeSlots({ dark: undefined, light: undefined });
});

describe("user themes", () => {
  it("join the catalog: themeById, themesFor (first), resolved like a curated theme", () => {
    const ocean = userFile("ocean-dusk", "Ocean Dusk", "catppuccin-mocha", { overrides: { "--cf-accent": "#5fb3b3", "--cf-not-a-slot": "#000000" }, createdBy: "s-1" });
    setUserThemes([ocean, userFile("paper", "Paper", "github-light")]);
    const t = themeById.get("ocean-dusk");
    expect(t).toMatchObject({ user: true, from: "catppuccin-mocha", createdBy: "s-1", name: "Ocean Dusk" });
    expect(t?.slots["--cf-accent"]).toBe("#5fb3b3");
    expect(t?.slots["--cf-surface"]).toBe(themeById.get("catppuccin-mocha")?.slots["--cf-surface"]);
    expect(t?.slots).not.toHaveProperty("--cf-not-a-slot");
    expect(themesFor("dark").map((x) => x.id).slice(0, 2)).toEqual(["ocean-dusk", "github-dark"]);
    expect(themesFor("light")[0]?.id).toBe("paper");
    expect(themes.some((x) => x.user)).toBe(false);
    expect(userThemes().map((x) => x.id)).toEqual(["ocean-dusk", "paper"]);
  });

  it("keep their Theme while the file is unchanged, and tell subscribers only on a change", () => {
    const cb = vi.fn();
    const stop = subscribeUserThemes(cb);
    setUserThemes([userFile("a", "A", "nord")]);
    const first = themeById.get("a");
    setUserThemes([userFile("a", "A", "nord")]);
    expect(themeById.get("a")).toBe(first);
    expect(cb).toHaveBeenCalledTimes(1);
    setUserThemes([userFile("a", "A", "nord", { overrides: { "--cf-accent": "#ff0000" } })]);
    expect(themeById.get("a")).not.toBe(first);
    expect(themeById.get("a")?.slots["--cf-accent"]).toBe("#ff0000");
    expect(cb).toHaveBeenCalledTimes(2);
    setUserThemes([]);
    expect(themeById.has("a")).toBe(false);
    expect(cb).toHaveBeenCalledTimes(3);
    stop();
  });

  it("never replace a curated theme", () => {
    setUserThemes([userFile("nord", "My Nord", "dracula")]);
    expect(themeById.get("nord")?.name).toBe("Nord");
    expect(userThemes()).toEqual([]);
  });

  it("are kept for the next launch", () => {
    setUserThemes([userFile("a", "A", "nord")]);
    expect(JSON.parse(localStorage.getItem(USER_THEMES_STORAGE_KEY) ?? "[]")).toMatchObject([{ id: "a", from: "nord" }]);
  });
});

describe("a slot naming a user theme", () => {
  it("shows the default until the theme arrives, then itself, and the default again once it goes", () => {
    setThemePreference("dark");
    setThemeSlots({ dark: "ocean-dusk" });
    expect(themeSlots().dark).toBe("github-dark");
    setUserThemes([userFile("ocean-dusk", "Ocean Dusk", "catppuccin-mocha")]);
    expect(themeSlots().dark).toBe("ocean-dusk");
    expect(activeTheme().id).toBe("ocean-dusk");
    // An edit of its file repaints: the active theme is the new one.
    const before = activeTheme();
    setUserThemes([userFile("ocean-dusk", "Ocean Dusk", "catppuccin-mocha", { overrides: { "--cf-accent": "#123456" } })]);
    expect(activeTheme()).not.toBe(before);
    expect(activeTheme().slots["--cf-accent"]).toBe("#123456");
    setUserThemes([]);
    expect(themeSlots().dark).toBe("github-dark");
  });
});
