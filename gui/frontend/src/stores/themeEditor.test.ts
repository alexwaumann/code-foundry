import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult }));
const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand }));

import { setUserThemes, themeById, type UserThemeFile } from "@/themes";
import { answerConfirm, useConfirmStore } from "./confirm";
import {
  analyse,
  baseValue,
  draftRefusal,
  editorDirty,
  fixSlotContrast,
  keepMine,
  leaveEditor,
  markFreshCopy,
  reloadFromDisk,
  pinSlot,
  resetSlotToDerived,
  revertEdits,
  saveEdits,
  schemeRefusal,
  setBaseColour,
  startEditing,
  stopEditing,
  syncFromDisk,
  unpinSlot,
  useThemeEditorStore,
  withBase,
} from "./themeEditor";

const gh = themeById.get("github-dark");
if (!gh) throw new Error("github-dark");
const OCEAN: UserThemeFile = {
  id: "ocean",
  name: "Ocean",
  scheme: "dark",
  source: "",
  base: gh.base,
  overrides: { "--cf-sidebar-row-selected": "#1e2e3c" },
  from: "github-dark",
  createdBy: "",
  path: "/h/themes/ocean.json",
};

const state = () => useThemeEditorStore.getState();
const draft = () => {
  const d = state().draft;
  if (!d) throw new Error("not editing");
  return d;
};
const report = () => analyse(draft(), state().basis);

beforeEach(() => {
  runCommandForResult.mockReset();
  invokeCommand.mockReset();
  invokeCommand.mockResolvedValue({ message: "", resultJson: "{}" });
  runCommandForResult.mockResolvedValue({ message: "", resultJson: "{}" });
  setUserThemes([OCEAN], false);
  stopEditing();
});

describe("base colours", () => {
  it("reads and writes every kind of key, clearing only the optional ones", () => {
    let b = withBase(gh.base, "canvas", "#101010");
    expect(baseValue(b, "canvas")).toBe("#101010");
    b = withBase(b, "terminal.ansi.3", "#abcdef");
    expect(baseValue(b, "terminal.ansi.3")).toBe("#abcdef");
    expect(gh.base.terminal.ansi[3]).not.toBe("#abcdef");
    b = withBase(b, "link", "#58a6ff");
    expect(withBase(b, "link", undefined)).not.toHaveProperty("link");
    expect(baseValue(withBase(b, "terminal.selection", "#333333"), "terminal.selection")).toBe("#333333");
    expect(withBase(b, "canvas", undefined)).toBe(b);
    expect(withBase(b, "terminal.foreground", undefined)).toBe(b);
  });
});

describe("the editor", () => {
  it("opens only a user theme, clean", () => {
    expect(startEditing("nord")).toBe(false);
    expect(startEditing("ocean")).toBe(true);
    expect(state().id).toBe("ocean");
    expect(editorDirty()).toBe(false);
    expect(report().pinned).toBe(1);
    expect(report().stale).toEqual([]);
  });

  it("a base change keeps pins and makes the one whose rule moved stale; Reset to derived and Unpin clear it", () => {
    startEditing("ocean");
    setBaseColour("canvas", "#202830");
    expect(editorDirty()).toBe(true);
    expect(draft().overrides).toEqual({ "--cf-sidebar-row-selected": "#1e2e3c" });
    expect(report().stale.map((p) => p.slot)).toEqual(["--cf-sidebar-row-selected"]);
    resetSlotToDerived("--cf-sidebar-row-selected");
    expect(report().stale).toEqual([]);
    expect(draft().overrides?.["--cf-sidebar-row-selected"]).toBe(report().slots["--cf-sidebar-row-selected"]);
    unpinSlot("--cf-sidebar-row-selected");
    expect(draft()).not.toHaveProperty("overrides");
  });

  it("a new pin's basis is what it derived just before", () => {
    startEditing("ocean");
    const before = report().slots["--cf-accent"];
    pinSlot("--cf-accent", "#ff0000");
    pinSlot("--cf-accent", "#ee0000");
    expect(state().basis["--cf-accent"]).toBe(before);
    expect(report().stale).toEqual([]);
  });

  it("Fix pins a stepped value for a failing slot", () => {
    startEditing("ocean");
    pinSlot("--cf-message-surface", `${report().slots["--cf-text"] ?? ""}ff`);
    expect(report().failing.has("--cf-message-foreground")).toBe(true);
    fixSlotContrast("--cf-message-foreground");
    expect(report().failing.has("--cf-message-foreground")).toBe(false);
    expect(draft().overrides).toHaveProperty("--cf-message-foreground");
  });

  it("Revert goes back to the saved file", () => {
    startEditing("ocean");
    setBaseColour("accent", "#ff00ff");
    revertEdits();
    expect(editorDirty()).toBe(false);
    expect(draft().base.accent).toBe(gh.base.accent);
  });

  it("Save writes the file through theme.save (renamed, same id) and applies when asked", async () => {
    startEditing("ocean");
    setBaseColour("accent", "#ff00ff");
    expect(await saveEdits({ name: " Ocean, pink ", apply: true })).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledTimes(1);
    const [cmd, args] = runCommandForResult.mock.calls[0] as [string, Record<string, string>];
    expect(cmd).toBe("theme.save");
    expect(args.apply).toBe("true");
    const file = JSON.parse(args.data ?? "") as Record<string, unknown>;
    expect(file).toMatchObject({ id: "ocean", name: "Ocean, pink", scheme: "dark", from: "github-dark", overrides: { "--cf-sidebar-row-selected": "#1e2e3c" } });
    expect(file).not.toHaveProperty("path");
    expect(file).not.toHaveProperty("createdBy");
    expect((file.base as Record<string, string>).accent).toBe("#ff00ff");
    expect(editorDirty()).toBe(false);
    expect(state().id).toBe("ocean");
    // Without apply, no apply arg.
    setBaseColour("accent", "#00ff00");
    await saveEdits({ name: "Ocean, pink", apply: false });
    expect((runCommandForResult.mock.calls[1] as [string, Record<string, string>])[1]).not.toHaveProperty("apply");
  });

  it("a refused save keeps the draft unsaved", async () => {
    startEditing("ocean");
    setBaseColour("accent", "#ff00ff");
    runCommandForResult.mockResolvedValueOnce(null);
    expect(await saveEdits({ name: "Ocean", apply: false })).toBe(false);
    expect(editorDirty()).toBe(true);
  });

  it("leaving with changes asks; Cancel stays, Discard leaves", async () => {
    startEditing("ocean");
    expect(await leaveEditor()).toBe(true);
    startEditing("ocean");
    setBaseColour("accent", "#ff00ff");
    let left = leaveEditor();
    expect(useConfirmStore.getState().pending?.message).toContain("Ocean has changes that are not saved");
    answerConfirm(false);
    expect(await left).toBe(false);
    expect(state().id).toBe("ocean");
    left = leaveEditor();
    answerConfirm(true);
    expect(await left).toBe(true);
    expect(state().id).toBeNull();
  });
});

describe("a newer file on disk", () => {
  const onDisk = (edit: Partial<UserThemeFile["base"]>) => {
    setUserThemes([{ ...OCEAN, base: { ...OCEAN.base, ...edit } }], false);
  };

  it("a clean editor reloads it, saved and draft, by itself", () => {
    startEditing("ocean");
    onDisk({ canvas: "#330000" });
    expect(draft().base.canvas).toBe("#330000");
    expect(state().saved?.base.canvas).toBe("#330000");
    expect(editorDirty()).toBe(false);
    expect(state().disk).toBeNull();
  });

  it("with unsaved edits it waits: Reload takes it, Keep mine keeps the draft and makes it what Revert goes to", () => {
    startEditing("ocean");
    setBaseColour("accent", "#ff00ff");
    onDisk({ canvas: "#330000" });
    expect(draft().base.canvas).toBe(gh.base.canvas);
    expect(state().disk?.base.canvas).toBe("#330000");
    keepMine();
    expect(state().disk).toBeNull();
    expect(draft().base.accent).toBe("#ff00ff");
    expect(state().saved?.base.canvas).toBe("#330000");
    revertEdits();
    expect(draft().base).toMatchObject({ canvas: "#330000", accent: gh.base.accent });

    setBaseColour("accent", "#00ff00");
    onDisk({ canvas: "#440000" });
    reloadFromDisk();
    expect(draft().base).toMatchObject({ canvas: "#440000", accent: gh.base.accent });
    expect(editorDirty()).toBe(false);
  });

  it("a file equal to the draft (this window's save, landing first) is the saved file; one equal to the saved file changes nothing", () => {
    startEditing("ocean");
    setBaseColour("accent", "#ff00ff");
    onDisk({ accent: "#ff00ff" });
    expect(editorDirty()).toBe(false);
    expect(state().disk).toBeNull();
    const before = state();
    syncFromDisk();
    expect(state()).toBe(before);
  });
});

describe("a Customise copy", () => {
  const COPY: UserThemeFile = { ...OCEAN, id: "ocean-copy", name: "Ocean copy", from: "ocean" };

  beforeEach(() => {
    setUserThemes([OCEAN, COPY], false);
  });

  it("closed without a save is deleted, without asking", async () => {
    markFreshCopy("ocean-copy");
    startEditing("ocean-copy");
    expect(state().fresh).toBe(true);
    expect(await leaveEditor()).toBe(true);
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("theme.delete", expect.anything(), { theme: "ocean-copy" }, undefined, { confirmed: true });
    });
  });

  it("is kept once saved, or when the editor was opened on it some other way", async () => {
    markFreshCopy("ocean-copy");
    startEditing("ocean-copy");
    setBaseColour("accent", "#ff00ff");
    expect(await saveEdits({ name: "Ocean copy", apply: false })).toBe(true);
    stopEditing();
    startEditing("ocean-copy");
    expect(state().fresh).toBe(false);
    stopEditing();
    await Promise.resolve();
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});

describe("what theme.save would refuse", () => {
  it("a surface its scheme cannot carry, in the editor's words", () => {
    expect(draftRefusal(OCEAN)).toBeNull();
    const light = { ...OCEAN, base: { ...OCEAN.base, surface: "#f0f0f0" } };
    expect(draftRefusal(light)).toEqual({ kind: "scheme", message: schemeRefusal("dark", "#f0f0f0") });
    expect(schemeRefusal("dark", "#f0f0f0")).toMatch(/^A dark theme needs a dark surface \(OKLab lightness at most 0\.45\); #f0f0f0 is 0\.9\d\. Darken the surface to save\.$/);
    expect(schemeRefusal("light", "#202020")).toContain("Lighten the surface");
    startEditing("ocean");
    setBaseColour("surface", "#f0f0f0");
    expect(report().refusal?.kind).toBe("scheme");
  });

  it("a name it does not take", () => {
    expect(draftRefusal(OCEAN, "Ocean\twarm")).toEqual({ kind: "file", message: "name: no control characters" });
    expect(draftRefusal(OCEAN, "x".repeat(81))?.message).toBe("name: at most 80 characters");
    expect(draftRefusal(OCEAN, "x".repeat(80))).toBeNull();
  });
});
