import { describe, expect, it } from "vitest";
import type { InstallProgressView } from "@/api/plugin";
import { applyInstallProgress, dismissInstallFailure, failedProgress, usePluginRegistryStore } from "./pluginRegistry";

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
