import { describe, expect, it } from "vitest";
import { themeById, type ThemeFile } from "@/themes";
import { themeUndoState, type ThemeLookup, type ThemeUndoTarget } from "./themeCards";

// The one Undo rule (docs/notes/theme-fuzz-daemon.md, model 4-6): what the slot showed just
// before the save, offered only while the slot still shows the card's colours.
const mocha = themeById.get("catppuccin-mocha");
if (!mocha) throw new Error("no catppuccin-mocha");
const saved: ThemeFile = { ...mocha, id: "ocean", name: "Ocean", base: { ...mocha.base, accent: "#5fb3b3" } };
const warmer: ThemeFile = { ...saved, base: { ...saved.base, accent: "#e0a060" } };

function lookup(themes: Record<string, { file: ThemeFile; version: string }>, history: Record<string, string[]> = {}): ThemeLookup {
  return {
    theme: (id) => {
      const t = themes[id];
      return t ? { ...t.file, version: t.version } : undefined;
    },
    history: (id) => history[id] ?? [],
  };
}

const other: ThemeUndoTarget = { scheme: "dark", id: "ocean", previous: "nord", version: "" };
const own: ThemeUndoTarget = { scheme: "dark", id: "ocean", previous: "ocean", version: "v1" };
const nord = { file: { ...mocha, id: "nord", name: "Nord" }, version: "" };

describe("themeUndoState", () => {
  it.each([
    { name: "back to another theme", t: other, slot: "ocean", look: lookup({ ocean: { file: saved, version: "v2" }, nord }), want: { kind: "undo", tip: "Back to Nord" } },
    { name: "the slot is back on it", t: other, slot: "nord", look: lookup({ ocean: { file: saved, version: "v2" }, nord }), want: { kind: "undone", tip: "The dark theme is Nord again" } },
    { name: "the slot moved on by hand", t: other, slot: "dracula", look: lookup({ ocean: { file: saved, version: "v2" }, nord }), want: { kind: "hidden" } },
    { name: "a later save changed the colours", t: other, slot: "ocean", look: lookup({ ocean: { file: warmer, version: "v3" }, nord }), want: { kind: "hidden" } },
    { name: "the previous theme was deleted", t: other, slot: "ocean", look: lookup({ ocean: { file: saved, version: "v2" } }), want: { kind: "gone", tip: "nord was deleted" } },
    { name: "the daemon found it gone", t: { ...other, gone: true }, slot: "ocean", look: lookup({ ocean: { file: saved, version: "v2" }, nord }), want: { kind: "gone", tip: "Nord was deleted" } },
    { name: "the previous colours, kept", t: own, slot: "ocean", look: lookup({ ocean: { file: saved, version: "v2" } }, { ocean: ["v1"] }),
      want: { kind: "undo", tip: "Undo restores the previous colours" } },
    { name: "the previous colours, no longer kept", t: own, slot: "ocean", look: lookup({ ocean: { file: saved, version: "v2" } }),
      want: { kind: "gone", tip: "The previous colours of Ocean are no longer kept" } },
    { name: "the previous colours are back", t: own, slot: "ocean", look: lookup({ ocean: { file: warmer, version: "v1" } }, { ocean: ["v2"] }),
      want: { kind: "undone", tip: "Ocean has its previous colours again" } },
    { name: "nothing to undo", t: { ...other, previous: "" }, slot: "ocean", look: lookup({}), want: { kind: "none" } },
  ])("$name", ({ t, slot, look, want }) => {
    expect(themeUndoState(t, saved, slot, look)).toEqual(want);
  });

  it("a toast (no file) follows the slot only", () => {
    expect(themeUndoState(other, null, "ocean", lookup({ ocean: { file: warmer, version: "v3" }, nord })).kind).toBe("undo");
  });
});
