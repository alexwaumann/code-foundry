import { describe, expect, it } from "vitest";
import type { UpdateStateView, UpdateStatusView } from "@/api/update";
import { compareVersions, updateBadge } from "./update";

function status(state: UpdateStateView, over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    state,
    currentVersion: "v0.1.0",
    enabled: true,
    disabledReason: "",
    releaseRepo: "o/n",
    checking: false,
    lastCheckedAt: null,
    lastCheckError: "",
    latestVersion: "",
    targetVersion: state === "idle" ? "" : "v0.2.0",
    notesUrl: "",
    progress: "",
    failureReason: "",
    ...over,
  };
}

describe("compareVersions", () => {
  it.each([
    ["v0.1.0", "v0.1.0", 0],
    ["v0.2.0", "v0.1.9", 1],
    ["v0.10.0", "v0.9.0", 1],
    ["v1.0.0-rc.1", "v1.0.0", -1],
    ["v1.0.0-rc.10", "v1.0.0-rc.9", 1],
    ["v1.0.0-alpha", "v1.0.0-1", 1],
    ["0.1.0", "v0.1.0", 0],
    ["dev", "v0.1.0", null],
  ])("%s vs %s", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });
});

describe("updateBadge", () => {
  it.each<[string, UpdateStatusView | null, string | null, string | null]>([
    ["no status", null, "v0.1.0", null],
    ["idle", status("idle"), "v0.1.0", null],
    ["available", status("available"), "v0.1.0", "update ready v0.2.0"],
    ["downloading", status("downloading"), "v0.1.0", "updating to v0.2.0…"],
    ["failed", status("failed"), "v0.1.0", "update failed"],
    ["installed, old GUI", status("installed"), "v0.1.0", "relaunch to apply"],
    ["installed, GUI unknown (browser)", status("installed"), null, "relaunch to apply"],
    ["installed, GUI already relaunched", status("installed"), "v0.2.0", "daemon restart pending"],
    ["restart required", status("restartRequired"), "v0.2.0", "daemon restart pending"],
    ["restart required, GUI unknown", status("restartRequired"), null, "daemon restart pending"],
    ["restart required, relaunch did not happen", status("restartRequired"), "v0.1.0", "relaunch to apply"],
    ["daemon restarted first", status("idle", { currentVersion: "v0.2.0" }), "v0.1.0", "relaunch to apply"],
    ["dev GUI against a release daemon", status("idle", { currentVersion: "v0.2.0" }), "dev", null],
    ["dev daemon, disabled", status("idle", { currentVersion: "dev", enabled: false }), "dev", null],
  ])("%s", (_name, st, gui, want) => {
    expect(updateBadge(st, gui)?.label ?? null).toBe(want);
  });
});
