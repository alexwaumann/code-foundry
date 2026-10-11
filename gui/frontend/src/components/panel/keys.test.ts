import { describe, expect, it, vi } from "vitest";
import { emptyEntry, makeTab, type PanelEntry } from "@/stores/panel";
import { filesSurface } from "@/surfaces/files";
import { surfaceByHotkey, surfaceOf, surfaces } from "@/surfaces/registry";
import type { SurfaceContext } from "@/surfaces/types";
import { isPanelChord, panelKeyAction, tabMoveIndex } from "./keys";

const ctx: SurfaceContext = { selection: { kind: "session", id: "s-1" }, panelKey: "session:s-1" };
const files = makeTab("files", "Files");
const withTab: PanelEntry = { open: true, tabs: [files], activeTabId: files.id };
const picking: PanelEntry = { open: true, tabs: [files], activeTabId: null, pickFrom: files.id };

describe("isPanelChord", () => {
  it.each([
    ["cmd+w", false, true],
    ["p", false, true],
    ["f", false, true],
    ["q", false, false],
    ["cmd+shift+c", false, false],
    ["cmd+p", false, false],
    // Surfaces use Escape (popups, the ask composer): the panel's only while picking.
    ["escape", false, false],
    ["escape", true, true],
    ["cmd+w", true, true],
    ["q", true, false],
  ])("%s (picking %s) -> %s", (chord, picking, want) => {
    expect(isPanelChord(chord, picking)).toBe(want);
  });
});

describe("panelKeyAction", () => {
  const cases: [string, string, PanelEntry, ReturnType<typeof panelKeyAction>][] = [
    ["cmd+w closes the active tab", "cmd+w", withTab, { kind: "close", tabId: files.id }],
    ["cmd+w with no tabs hides the panel", "cmd+w", { ...emptyEntry, open: true }, { kind: "hide" }],
    ["disabled surface hotkey does nothing", "f", withTab, null],
    ["pull request is disabled for now", "p", withTab, null],
    ["unknown letter does nothing", "q", withTab, null],
    ["modified letter is not a hotkey", "cmd+f", withTab, null],
    ["cmd+w while picking goes back instead of hiding", "cmd+w", picking, { kind: "stopPicking" }],
    ["escape while picking goes back", "escape", picking, { kind: "stopPicking" }],
    ["escape with an active tab does nothing", "escape", withTab, null],
    ["escape with no tabs does nothing", "escape", { ...emptyEntry, open: true }, null],
    ["a disabled hotkey while picking does nothing", "f", picking, null],
  ];
  it.each(cases)("%s", (_name, chord, entry, want) => {
    expect(panelKeyAction(chord, entry, ctx)).toEqual(want);
  });

  it("an enabled surface's hotkey opens its default tab", () => {
    const spy = vi.spyOn(filesSurface, "available").mockReturnValue("enabled");
    expect(panelKeyAction("f", { ...emptyEntry, open: true }, ctx)).toEqual({ kind: "open", tab: files });
    // While picking too: the letter picks from the list.
    expect(panelKeyAction("f", picking, ctx)).toEqual({ kind: "open", tab: files });
    spy.mockRestore();
  });
});

describe("tabMoveIndex", () => {
  it.each<[string, string, number, number, number | null]>([
    ["alt+right moves one slot right", "alt+arrowright", 0, 3, 1],
    ["alt+left moves one slot left", "alt+arrowleft", 2, 3, 1],
    ["alt+right on the last tab stays (no wrap)", "alt+arrowright", 2, 3, 2],
    ["alt+left on the first tab stays (no wrap)", "alt+arrowleft", 0, 3, 0],
    ["a single tab stays", "alt+arrowright", 0, 1, 0],
    ["a plain arrow is not a move", "arrowright", 0, 3, null],
    ["alt+shift+arrow is not a move", "alt+shift+arrowleft", 1, 3, null],
    ["cmd+alt+arrow is not a move", "cmd+alt+arrowright", 1, 3, null],
    ["alt+up is not a move", "alt+arrowup", 1, 3, null],
    ["no focused tab", "alt+arrowright", -1, 3, null],
    ["an index past the strip", "alt+arrowleft", 3, 3, null],
  ])("%s", (_name, chord, index, count, want) => {
    expect(tabMoveIndex(chord, index, count)).toBe(want);
  });
});

describe("surface registry", () => {
  it("has unique kinds and single-letter hotkeys", () => {
    expect(new Set(surfaces.map((s) => s.kind)).size).toBe(surfaces.length);
    const hotkeys = surfaces.flatMap((s) => (s.hotkey ? [s.hotkey] : []));
    expect(new Set(hotkeys).size).toBe(hotkeys.length);
    for (const k of hotkeys) expect(k).toMatch(/^[a-z]$/);
    // cmd+w is the panel's; a bare w is the workspace surface's letter.
    expect(isPanelChord("w")).toBe(true);
  });

  it("looks surfaces up by kind and hotkey", () => {
    expect(surfaces.map((s) => [s.kind, s.hotkey])).toEqual([
      ["files", "f"],
      ["diff", "d"],
      ["pullrequest", "p"],
      ["linkedprs", "l"],
      ["usage", "u"],
      ["workspace", "w"],
      ["worktree", "t"],
    ]);
    expect(surfaceOf("diff")?.title).toBe("Diff");
    expect(surfaceByHotkey("P")?.kind).toBe("pullrequest");
    expect(surfaceByHotkey("W")?.kind).toBe("workspace");
    expect(surfaceByHotkey("l")?.kind).toBe("linkedprs");
    expect(surfaceByHotkey("U")?.kind).toBe("usage");
    expect(surfaceByHotkey("T")?.kind).toBe("worktree");
    // s-1 is unknown here: no pull request, no linked pull requests, no workspace thread,
    // no worktree to place it in.
    expect(surfaces.map((s) => s.available(ctx))).toEqual(["disabled", "disabled", "disabled", "hidden", "hidden", "hidden", "hidden"]);
  });
});
