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
    expect(new Set(surfaces.map((s) => s.hotkey)).size).toBe(surfaces.length);
    for (const s of surfaces) expect(s.hotkey).toMatch(/^[a-z]$/);
  });

  it("looks surfaces up by kind and hotkey", () => {
    expect(surfaces.map((s) => [s.kind, s.hotkey])).toEqual([
      ["files", "f"],
      ["diff", "d"],
      ["pullrequest", "p"],
    ]);
    expect(surfaceOf("diff")?.title).toBe("Diff");
    expect(surfaceByHotkey("P")?.kind).toBe("pullrequest");
    for (const s of surfaces) expect(s.available(ctx)).toBe("disabled");
  });
});
