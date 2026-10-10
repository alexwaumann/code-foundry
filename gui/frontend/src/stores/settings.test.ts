import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSnapshotView } from "@/api/settings";
import { effectiveScheme } from "@/lib/theme";
import { answerConfirm, useConfirmStore } from "./confirm";
import { applySettingsSnapshot, terminalFontFamily, useSettingsStore, zoomUi } from "./settings";
import { useUiStore } from "./ui";
import { showView, useViewsStore } from "./views";

const invokeCommand = vi.hoisted(() => vi.fn());
const needsConfirm = vi.hoisted(() => new Error("needs confirmation"));
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  confirmationOf: (err: unknown) => (err === needsConfirm ? { command: "session.remove", title: "Remove Session", message: "Remove session s1?" } : null),
}));
const { runCommand } = await import("./commands");

function snap(values: Record<string, string>, revision = 1): SettingsSnapshotView {
  return { values, path: "/h/settings.toml", revision, loadError: "", issues: [], restartPending: [] };
}

describe("applySettingsSnapshot", () => {
  beforeEach(() => {
    useSettingsStore.setState({ snapshot: null });
    useUiStore.setState({ fontSize: 13, zoom: 100 });
  });

  it("applies theme, font size and density", () => {
    applySettingsSnapshot(snap({ "appearance.theme": "light", "appearance.font_size": "16", "appearance.density": "comfortable" }));
    expect(effectiveScheme()).toBe("light");
    expect(useUiStore.getState().fontSize).toBe(16);
    expect(document.documentElement.dataset.density).toBe("comfortable");
    applySettingsSnapshot(snap({ "appearance.theme": "dark", "appearance.font_size": "16", "appearance.density": "compact" }, 2));
    expect(effectiveScheme()).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("moves the font size only when the setting changes", () => {
    applySettingsSnapshot(snap({ "appearance.font_size": "14" }));
    useUiStore.getState().setFontSize(18); // a zoom not saved yet
    applySettingsSnapshot(snap({ "appearance.font_size": "14", "appearance.theme": "dark" }, 2));
    expect(useUiStore.getState().fontSize).toBe(18);
    applySettingsSnapshot(snap({ "appearance.font_size": "20" }, 3));
    expect(useUiStore.getState().fontSize).toBe(20);
  });

  it("moves the zoom only when the setting changes", () => {
    applySettingsSnapshot(snap({ "appearance.zoom": "125" }));
    expect(useUiStore.getState().zoom).toBe(125);
    useUiStore.getState().setZoom(150); // a zoom not saved yet
    applySettingsSnapshot(snap({ "appearance.zoom": "125", "appearance.theme": "dark" }, 2));
    expect(useUiStore.getState().zoom).toBe(150);
    applySettingsSnapshot(snap({ "appearance.zoom": "90" }, 3));
    expect(useUiStore.getState().zoom).toBe(90);
  });

  it("builds the terminal font stack", () => {
    expect(terminalFontFamily("Iosevka")).toMatch(/^Iosevka, "SF Mono", ui-monospace/);
    expect(terminalFontFamily("  ")).toMatch(/^"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SF Mono"/);
    expect(terminalFontFamily(undefined)).toBe(terminalFontFamily(""));
  });
});

describe("zoomUi", () => {
  beforeEach(() => {
    useSettingsStore.setState({ snapshot: null });
    useUiStore.setState({ zoom: 100 });
  });

  it("steps the browser zoom ladder and resets to 100", () => {
    zoomUi(1);
    expect(useUiStore.getState().zoom).toBe(110);
    zoomUi(1);
    expect(useUiStore.getState().zoom).toBe(125);
    zoomUi(-1);
    zoomUi(-1);
    zoomUi(-1);
    expect(useUiStore.getState().zoom).toBe(90);
    zoomUi(-1);
    expect(useUiStore.getState().zoom).toBe(90);
    zoomUi(null);
    expect(useUiStore.getState().zoom).toBe(100);
  });

  it("stops at the ends of the ladder", () => {
    for (let i = 0; i < 20; i++) zoomUi(1);
    expect(useUiStore.getState().zoom).toBe(200);
    for (let i = 0; i < 20; i++) zoomUi(-1);
    expect(useUiStore.getState().zoom).toBe(90);
  });
});

describe("views", () => {
  it("shows settings and help by name", () => {
    expect(showView("settings")).toBe(true);
    expect(useViewsStore.getState().settingsOpen).toBe(true);
    expect(showView("help")).toBe(true);
    expect(useViewsStore.getState().helpOpen).toBe(true);
    expect(showView("pulls")).toBe(false);
  });
});

describe("runCommand confirmation", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it.each([
    [true, 2],
    [false, 1],
  ])("confirm=%s invokes %i time(s)", async (yes, calls) => {
    invokeCommand.mockRejectedValueOnce(needsConfirm).mockResolvedValue({ message: "", resultJson: "" });
    const ctx = { activeTerminalId: "", activeSessionId: "s1", activeRepoId: "", activeWorktreePath: "", activeView: "session", activeWorkspaceId: "" };
    const done = runCommand("session.remove", {}, ctx);
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.message).toBe("Remove session s1?");
    });
    answerConfirm(yes);
    expect(await done).toBe(yes);
    expect(invokeCommand).toHaveBeenCalledTimes(calls);
    if (yes) expect(invokeCommand).toHaveBeenLastCalledWith("session.remove", ctx, {}, undefined, { confirmed: true });
  });
});
