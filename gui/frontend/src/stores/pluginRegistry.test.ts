import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallProgressView } from "@/api/plugin";
import { confirmPresenter, useConfirmStore } from "./confirm";

const m = vi.hoisted(() => ({ browse: vi.fn(), runCommand: vi.fn(), runCommandForResult: vi.fn() }));
vi.mock("@/api/plugin", async (orig) => ({ ...(await orig<typeof import("@/api/plugin")>()), browsePlugins: m.browse }));
vi.mock("./commands", () => ({ runCommand: m.runCommand, runCommandForResult: m.runCommandForResult }));

const { applyInstallProgress, dismissInstallFailure, failedProgress, installPlugin, onInstallProgress, onRegistryEpoch, uninstallPlugin, usePluginRegistryStore } = await import("./pluginRegistry");

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.browse.mockResolvedValue({ entries: [], registries: [], platform: "darwin/arm64" });
  m.runCommand.mockResolvedValue(true);
  usePluginRegistryStore.setState({ progress: {}, busy: {} });
  useConfirmStore.setState({ pending: null });
});

const step = (phase: InstallProgressView["phase"], name = "hello", ref = "hello"): InstallProgressView => ({ ref, name, version: "0.1.0", phase, message: phase, bytes: 0 });

describe("applyInstallProgress", () => {
  it("keeps the latest step per plugin, drops it when done, keeps a failure", () => {
    let s = applyInstallProgress({}, step("resolving", "", "hello"));
    expect(Object.keys(s)).toEqual(["hello"]);
    s = applyInstallProgress(s, step("downloading"));
    expect(s.hello?.phase).toBe("downloading");
    s = applyInstallProgress(s, step("failed"));
    expect(s.hello?.phase).toBe("failed");
    s = applyInstallProgress(s, step("done"));
    expect(s).toEqual({});
  });

  it("moves a step keyed by its ref to the resolved name", () => {
    const s = applyInstallProgress(applyInstallProgress({}, step("resolving", "", "o/repo")), step("downloading", "repo-plugin", "o/repo"));
    expect(Object.keys(s)).toEqual(["repo-plugin"]);
  });
});

describe("failedProgress", () => {
  it.each([
    ["keeps the daemon's failed step", { hello: { ...step("failed"), message: "checksum mismatch" } }, "command error", { phase: "failed", message: "checksum mismatch" }],
    ["puts the command's error on a step in flight", { hello: step("downloading") }, "no plugin \"hello\" in the registries", { phase: "failed", message: 'no plugin "hello" in the registries' }],
    ["puts the command's error where nothing was", {}, "gh: not logged in", { phase: "failed", message: "gh: not logged in" }],
    ["drops the step when the user declined (no error)", { hello: step("resolving") }, "", undefined],
  ])("%s", (_name, before, error, want) => {
    const s = failedProgress(before, "hello", error);
    if (want === undefined) expect(s.hello).toBeUndefined();
    else expect(s.hello).toMatchObject(want);
  });
});

describe("dismissInstallFailure", () => {
  it("takes a failure away and leaves a step in flight", () => {
    usePluginRegistryStore.setState({ progress: { hello: step("failed"), other: step("downloading", "other", "other") } });
    dismissInstallFailure("hello");
    dismissInstallFailure("other");
    expect(Object.keys(usePluginRegistryStore.getState().progress)).toEqual(["other"]);
  });
});

describe("installPlugin", () => {
  const installed = (enabled: boolean) => ({ message: "", resultJson: JSON.stringify({ plugin: { name: "gh-actions", enabled }, version: "0.1.0", changed: true }) });

  it("runs plugin.install for the ref, clears the row's progress, then enables it (whose consent asks first)", async () => {
    let during: InstallProgressView | undefined;
    m.runCommandForResult.mockImplementation(() => {
      during = usePluginRegistryStore.getState().progress["gh-actions"];
      return Promise.resolve(installed(false));
    });
    await installPlugin("gh-actions");
    expect(m.runCommandForResult).toHaveBeenCalledWith("plugin.install", { ref: "gh-actions" }, expect.objectContaining({ quiet: true }));
    expect(during?.phase).toBe("resolving");
    expect(usePluginRegistryStore.getState().progress).toEqual({});
    expect(usePluginRegistryStore.getState().busy).toEqual({});
    expect(m.runCommand).toHaveBeenCalledWith("plugin.enable", { name: "gh-actions" });
    expect(m.browse).toHaveBeenCalled();
  });

  it("does not enable what is enabled already", async () => {
    m.runCommandForResult.mockResolvedValue(installed(true));
    await installPlugin("gh-actions");
    expect(m.runCommand).not.toHaveBeenCalled();
  });

  it("a failure keeps the daemon's words for the row; the next try starts over and clears them", async () => {
    const words = "gh-actions: no build for darwin/arm64 in release v0.1.0";
    m.runCommandForResult.mockImplementation((_n: string, _a: unknown, opts: { onError?: (m: string) => void }) => {
      opts.onError?.(words);
      return Promise.resolve(null);
    });
    await installPlugin("gh-actions");
    expect(usePluginRegistryStore.getState().progress["gh-actions"]).toMatchObject({ phase: "failed", message: words });
    expect(m.runCommand).not.toHaveBeenCalled();

    let during: InstallProgressView | undefined;
    m.runCommandForResult.mockImplementation(() => {
      during = usePluginRegistryStore.getState().progress["gh-actions"];
      return Promise.resolve(installed(false));
    });
    await installPlugin("gh-actions");
    expect(during?.phase).toBe("resolving");
    expect(usePluginRegistryStore.getState().progress["gh-actions"]).toBeUndefined();
    expect(m.runCommand).toHaveBeenCalledWith("plugin.enable", { name: "gh-actions" });
  });
});

describe("uninstallPlugin", () => {
  const ask = (purge: string) => confirmPresenter("plugin.uninstall")?.({ title: "", message: "Uninstall?", confirmLabel: "", command: "plugin.uninstall", args: { name: "test-watcher", purge } });

  it("runs plugin.uninstall with the purge choice and answers its daemon confirm itself: no second dialog", async () => {
    let answered: boolean | undefined;
    m.runCommand.mockImplementation(async () => {
      answered = await ask("true");
      return true;
    });
    await uninstallPlugin("test-watcher", true);
    expect(m.runCommand).toHaveBeenCalledWith("plugin.uninstall", { name: "test-watcher", purge: "true" });
    expect(answered).toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it("from anywhere else (the palette), the generic confirm asks", () => {
    void ask("false");
    expect(useConfirmStore.getState().pending?.message).toBe("Uninstall?");
  });
});

describe("the daemon's plugin events", () => {
  it("an install step lands under its row", () => {
    onInstallProgress({ ref: "gh-actions", name: "gh-actions", version: "0.1.0", phase: "downloading", message: "", bytes: 2_621_440 });
    expect(usePluginRegistryStore.getState().progress["gh-actions"]).toMatchObject({ phase: "downloading", bytes: 2_621_440 });
    onInstallProgress({ ref: "gh-actions", name: "gh-actions", version: "0.1.0", phase: "done", message: "", bytes: 0 });
    expect(usePluginRegistryStore.getState().progress).toEqual({});
  });

  it("a new registry epoch re-reads Browse once it has been read (a registry setting changed)", () => {
    vi.useFakeTimers();
    try {
      usePluginRegistryStore.setState({ browse: null, epoch: 0 });
      onRegistryEpoch(1);
      vi.advanceTimersByTime(200);
      expect(m.browse).not.toHaveBeenCalled();

      usePluginRegistryStore.setState({ browse: { entries: [], registries: [], platform: "darwin/arm64" } });
      onRegistryEpoch(2);
      onRegistryEpoch(2);
      vi.advanceTimersByTime(200);
      expect(m.browse).toHaveBeenCalledTimes(1);
      expect(usePluginRegistryStore.getState().epoch).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
