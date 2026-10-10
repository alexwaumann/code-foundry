import { describe, expect, it, vi } from "vitest";
import { emptyEntry, makeTab, type PanelEntry } from "@/stores/panel";
import { filesSurface } from "@/surfaces/files";
import { surfaceByHotkey, surfaceOf, surfaces } from "@/surfaces/registry";
import type { SurfaceContext } from "@/surfaces/types";
import { isPanelChord, panelKeyAction } from "./keys";

const ctx: SurfaceContext = { selection: { kind: "session", id: "s-1" }, panelKey: "session:s-1" };
const files = makeTab("files", "Files");
const withTab: PanelEntry = { open: true, tabs: [files], activeTabId: files.id };

describe("isPanelChord", () => {
  it.each([
    ["cmd+w", true],
    ["p", true],
    ["f", true],
    ["q", false],
    ["cmd+shift+c", false],
    ["cmd+p", false],
  ])("%s -> %s", (chord, want) => {
    expect(isPanelChord(chord)).toBe(want);
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
  ];
  it.each(cases)("%s", (_name, chord, entry, want) => {
    expect(panelKeyAction(chord, entry, ctx)).toEqual(want);
  });

  it("an enabled surface's hotkey opens its default tab", () => {
    const spy = vi.spyOn(filesSurface, "available").mockReturnValue("enabled");
    expect(panelKeyAction("f", { ...emptyEntry, open: true }, ctx)).toEqual({ kind: "open", tab: files });
    spy.mockRestore();
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
      ["workspace", "w"],
      ["worktree", "t"],
    ]);
    expect(surfaceOf("diff")?.title).toBe("Diff");
    expect(surfaceByHotkey("P")?.kind).toBe("pullrequest");
    expect(surfaceByHotkey("W")?.kind).toBe("workspace");
    expect(surfaceByHotkey("l")?.kind).toBe("linkedprs");
    expect(surfaceByHotkey("T")?.kind).toBe("worktree");
    // s-1 is unknown here: no pull request, no linked pull requests, no workspace thread,
    // no worktree to place it in.
    expect(surfaces.map((s) => s.available(ctx))).toEqual(["disabled", "disabled", "disabled", "hidden", "hidden", "hidden"]);
  });
});
