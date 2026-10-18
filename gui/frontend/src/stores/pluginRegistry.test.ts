import { describe, expect, it } from "vitest";
import type { InstallProgressView } from "@/api/plugin";
import { applyInstallProgress } from "./pluginRegistry";

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
