import { describe, expect, it } from "vitest";
import type { UpdateStateView, UpdateStatusView } from "@/api/update";
import type { CutOff } from "./session";
import { busyHeading, compareVersions, cutOffLabel, displayVersion, failureHeadline, olderStable, updateBadge, updateView, versionMismatch, type Restarting, type ThreadActivity, type UpdateVariant } from "./update";

describe("displayVersion", () => {
  it.each([
    ["v0.15.0-tip.3", "v0.15.0 (tip 3)"],
    ["v0.14.42-tip.1", "v0.14.42 (tip 1)"],
    ["v1.0.0-tip.12", "v1.0.0 (tip 12)"],
    ["0.15.0-tip.3", "0.15.0 (tip 3)"],
    ["v0.15.0", "v0.15.0"],
    ["v1.0.0-rc.1", "v1.0.0-rc.1"],
    ["v0.15.0-tip", "v0.15.0-tip"],
    ["v0.15.0-tip.3.1", "v0.15.0-tip.3.1"],
    ["dev", "dev"],
    ["", ""],
  ])("%s", (v, want) => {
    expect(displayVersion(v)).toBe(want);
  });
});

describe("olderStable", () => {
  it.each<[string, Partial<UpdateStatusView>, boolean]>([
    ["tip build on stable, stable behind", { channel: "stable", currentVersion: "v0.15.0-tip.2", latestVersion: "v0.14.41" }, true],
    ["tip build on stable, promotion landed", { channel: "stable", currentVersion: "v0.15.0-tip.2", latestVersion: "v0.15.0" }, false],
    ["stable build up to date", { channel: "stable", currentVersion: "v0.14.41", latestVersion: "v0.14.41" }, false],
    ["tip channel never says so", { channel: "tip", currentVersion: "v0.15.0-tip.2", latestVersion: "v0.14.41" }, false],
    ["not checked since the switch", { channel: "stable", currentVersion: "v0.15.0-tip.2", latestVersion: "" }, false],
    ["dev build", { channel: "stable", currentVersion: "dev", latestVersion: "v0.14.41" }, false],
  ])("%s", (_name, over, want) => {
    expect(olderStable(status("idle", over))).toBe(want);
  });
});

function status(state: UpdateStateView, over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    state,
    currentVersion: "v0.1.0",
    enabled: true,
    disabledReason: "",
    releaseRepo: "o/n",
    channel: "stable",
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

describe("versionMismatch", () => {
  it.each<[string, UpdateStatusView, string | null, string | null]>([
    ["browser (no GUI version)", status("installed"), null, null],
    ["idle, same", status("idle"), "v0.1.0", null],
    ["idle, GUI newer", status("idle"), "v0.2.0", "v0.2.0"],
    ["idle, daemon newer", status("idle", { currentVersion: "v0.2.0" }), "v0.1.0", "v0.2.0"],
    ["idle, dev GUI", status("idle", { currentVersion: "v0.2.0" }), "dev", null],
    ["installed, old GUI", status("installed"), "v0.1.0", null],
    ["installed, GUI on target", status("installed"), "v0.2.0", "v0.2.0"],
    ["restartRequired, GUI on target", status("restartRequired"), "v0.2.0", "v0.2.0"],
    ["available, GUI on target", status("available"), "v0.2.0", null],
    ["downloaded, GUI on target", status("downloaded"), "v0.2.0", null],
    ["downloaded, old GUI", status("downloaded"), "v0.1.0", null],
  ])("%s", (_name, st, gui, want) => {
    expect(versionMismatch(st, gui)?.version ?? null).toBe(want);
  });
});

describe("updateBadge", () => {
  it.each<[string, UpdateStatusView | null, string | null, string | null, string | null]>([
    ["no status", null, "v0.1.0", null, null],
    ["idle", status("idle"), "v0.1.0", null, null],
    ["available", status("available"), "v0.1.0", "v0.2.0 available", "Download"],
    ["downloading", status("downloading"), "v0.1.0", "Downloading v0.2.0…", ""],
    ["downloaded", status("downloaded"), "v0.1.0", "v0.2.0 downloaded", "Restart to apply"],
    ["downloaded, GUI unknown (browser)", status("downloaded"), null, "v0.2.0 downloaded", "Restart to apply"],
    ["failed", status("failed"), "v0.1.0", "Update failed", "Details"],
    ["installed, old GUI", status("installed"), "v0.1.0", "v0.2.0 installed", "Restart to apply"],
    ["installed, GUI unknown (browser)", status("installed"), null, "v0.2.0 installed", "Restart to apply"],
    ["installed, GUI already relaunched", status("installed"), "v0.2.0", "v0.2.0 installed", "Restart to apply"],
    ["restart required", status("restartRequired"), "v0.2.0", "v0.2.0 installed", "Restart to apply"],
    ["partly applied: GUI newer, idle", status("idle"), "v0.2.0", "v0.2.0 installed", "Restart to apply"],
    ["partly applied: daemon restarted first", status("idle", { currentVersion: "v0.2.0" }), "v0.1.0", "v0.2.0 installed", "Restart to apply"],
    ["dev GUI against a release daemon", status("idle", { currentVersion: "v0.2.0" }), "dev", null, null],
    ["dev daemon, disabled", status("idle", { currentVersion: "dev", enabled: false }), "dev", null, null],
    ["tip available", status("available", { targetVersion: "v0.15.0-tip.3", channel: "tip" }), null, "v0.15.0 (tip 3) available", "Download"],
    ["tip downloading", status("downloading", { targetVersion: "v0.15.0-tip.3", channel: "tip" }), null, "Downloading v0.15.0 (tip 3)…", ""],
    ["tip downloaded", status("downloaded", { targetVersion: "v0.15.0-tip.3", channel: "tip" }), null, "v0.15.0 (tip 3) downloaded", "Restart to apply"],
    ["tip installed", status("installed", { targetVersion: "v0.15.0-tip.3", channel: "tip" }), null, "v0.15.0 (tip 3) installed", "Restart to apply"],
    ["tip partly applied", status("idle", { currentVersion: "v0.15.0-tip.2" }), "v0.15.0-tip.3", "v0.15.0 (tip 3) installed", "Restart to apply"],
  ])("%s", (_name, st, gui, label, cta) => {
    const b = updateBadge(st, gui);
    expect(b?.label ?? null).toBe(label);
    expect(b?.cta ?? null).toBe(cta);
  });

  it("kinds", () => {
    expect(updateBadge(status("restartRequired"), null)?.kind).toBe("installed");
    expect(updateBadge(status("idle"), "v0.2.0")?.kind).toBe("installed");
    expect(updateBadge(status("failed"), null)?.kind).toBe("failed");
    expect(updateBadge(status("downloading"), null)?.kind).toBe("downloading");
    // Downloaded is not a mismatch: the GUI on the target cannot happen before the install.
    expect(updateBadge(status("downloaded"), null)?.kind).toBe("downloaded");
    expect(updateBadge(status("downloaded"), "v0.2.0")?.kind).toBe("downloaded");
  });
});

const none: ThreadActivity = { busy: 0 };

describe("updateView", () => {
  it.each<[string, UpdateStatusView, string | null, ThreadActivity, Restarting | null, UpdateVariant, string, string, string | null, boolean, boolean]>([
    // name, status, gui, threads, restarting -> variant, title, body, later, close, showBusy
    ["ready, nothing running", status("installed"), "v0.1.0", none, null, "readyIdle", "Code Foundry v0.2.0 is ready", "Restart to finish updating. No thread is working or waiting on you, so nothing will be interrupted.", "Later", false, false],
    [
      "ready, threads mid-turn",
      status("restartRequired"),
      null,
      { busy: 2 },
      null,
      "readyBusy",
      "Code Foundry v0.2.0 is ready",
      "Restarting now cuts these threads off. Let them finish first, or restart anyway: they keep their history, and a message continues each.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "downloaded, nothing running",
      status("downloaded"),
      "v0.1.0",
      none,
      null,
      "readyIdle",
      "Code Foundry v0.2.0 is ready",
      "Install and restart to finish updating. The app and the daemon update together, so nothing ends up out of sync. No thread is working or waiting on you, so nothing will be interrupted.",
      "Later",
      false,
      false,
    ],
    [
      "downloaded, threads mid-turn",
      status("downloaded"),
      null,
      { busy: 2 },
      null,
      "readyBusy",
      "Code Foundry v0.2.0 is ready",
      "Restarting now cuts these threads off. Let them finish first, or install and restart anyway: they keep their history, and a message continues each.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "downloaded, one thread mid-turn",
      status("downloaded"),
      null,
      { busy: 1 },
      null,
      "readyBusy",
      "Code Foundry v0.2.0 is ready",
      "Restarting now cuts this thread off. Let it finish first, or install and restart anyway: it keeps its history, and a message continues it.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "downloaded with the GUI on the target is no mismatch",
      status("downloaded"),
      "v0.2.0",
      none,
      null,
      "readyIdle",
      "Code Foundry v0.2.0 is ready",
      "Install and restart to finish updating. The app and the daemon update together, so nothing ends up out of sync. No thread is working or waiting on you, so nothing will be interrupted.",
      "Later",
      false,
      false,
    ],
    [
      "ready, one thread mid-turn",
      status("installed"),
      null,
      { busy: 1 },
      null,
      "readyBusy",
      "Code Foundry v0.2.0 is ready",
      "Restarting now cuts this thread off. Let it finish first, or restart anyway: it keeps its history, and a message continues it.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "available",
      status("available"),
      "v0.1.0",
      none,
      null,
      "available",
      "Code Foundry v0.2.0 is available",
      "You’re on v0.1.0. Downloading happens in the background and changes nothing until you restart.",
      "Later",
      false,
      false,
    ],
    [
      "downloading",
      status("downloading"),
      "v0.1.0",
      none,
      null,
      "downloading",
      "Downloading v0.2.0…",
      "You can close this and keep working. Nothing changes on disk until you install and restart.",
      "Hide",
      false,
      false,
    ],
    ["up to date", status("idle"), "v0.1.0", { busy: 1 }, null, "upToDate", "You’re up to date", "Code Foundry v0.1.0 is the latest version.", null, true, false],
    ["checking", status("idle", { checking: true }), null, none, null, "upToDate", "Checking for updates…", "Code Foundry v0.1.0 is the latest version.", null, true, false],
    [
      "up to date on tip",
      status("idle", { channel: "tip", currentVersion: "v0.15.0-tip.3", latestVersion: "v0.15.0-tip.3" }),
      null,
      none,
      null,
      "upToDate",
      "You’re up to date",
      "Code Foundry v0.15.0 (tip 3) is the latest version.",
      null,
      true,
      false,
    ],
    [
      "tip to stable, tip ahead: older stable",
      status("idle", { channel: "stable", currentVersion: "v0.15.0-tip.2", latestVersion: "v0.14.41" }),
      null,
      none,
      null,
      "upToDate",
      "You’re up to date",
      "Stable v0.14.41 is older than this build; the next stable release will move you.",
      null,
      true,
      false,
    ],
    [
      "tip to stable, tip behind: the promotion is offered",
      status("available", { channel: "stable", currentVersion: "v0.15.0-tip.2", latestVersion: "v0.15.0", targetVersion: "v0.15.0" }),
      null,
      none,
      null,
      "available",
      "Code Foundry v0.15.0 is available",
      "You’re on v0.15.0 (tip 2). Downloading happens in the background and changes nothing until you restart.",
      "Later",
      false,
      false,
    ],
    [
      "stable to tip, tip ahead",
      status("available", { channel: "tip", currentVersion: "v0.14.41", latestVersion: "v0.15.0-tip.3", targetVersion: "v0.15.0-tip.3" }),
      null,
      none,
      null,
      "available",
      "Code Foundry v0.15.0 (tip 3) is available",
      "You’re on v0.14.41. Downloading happens in the background and changes nothing until you restart.",
      "Later",
      false,
      false,
    ],
    [
      "tip partly applied",
      status("installed", { channel: "tip", currentVersion: "v0.15.0-tip.2", targetVersion: "v0.15.0-tip.3" }),
      "v0.15.0-tip.3",
      none,
      null,
      "partlyApplied",
      "Code Foundry v0.15.0 (tip 3) is partly applied",
      "The app is on v0.15.0 (tip 3) but the daemon is still on v0.15.0 (tip 2); some things won’t work until you restart.",
      "Later",
      false,
      false,
    ],
    [
      "partly applied: GUI newer, idle, busy threads",
      status("idle"),
      "v0.2.0",
      { busy: 2 },
      null,
      "partlyApplied",
      "Code Foundry v0.2.0 is partly applied",
      "The app is on v0.2.0 but the daemon is still on v0.1.0; some things won’t work until you restart. Restarting now cuts these threads off.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "partly applied: installed, GUI on target, nothing busy",
      status("installed"),
      "v0.2.0",
      { busy: 0 },
      null,
      "partlyApplied",
      "Code Foundry v0.2.0 is partly applied",
      "The app is on v0.2.0 but the daemon is still on v0.1.0; some things won’t work until you restart.",
      "Later",
      false,
      false,
    ],
    [
      "partly applied: daemon newer",
      status("idle", { currentVersion: "v0.2.0" }),
      "v0.1.0",
      none,
      null,
      "partlyApplied",
      "Code Foundry v0.2.0 is partly applied",
      "The daemon is on v0.2.0 but the app is still on v0.1.0; some things won’t work until you restart.",
      "Later",
      false,
      false,
    ],
    ["failed", status("failed", { failureReason: "x" }), "v0.1.0", none, null, "failed", "Couldn’t update to v0.2.0", "Nothing changed. You’re still on v0.1.0.", "Not now", false, false],
    ["restarting", status("idle", { currentVersion: "v0.2.0" }), "v0.1.0", { busy: 1 }, { install: "" }, "restarting", "Restarting…", "Code Foundry will reopen in a moment.", null, false, false],
    [
      "restarting after a download: installs first",
      status("installed"),
      null,
      none,
      { install: "v0.2.0" },
      "restarting",
      "Installing and restarting…",
      "Code Foundry will reopen in a moment on v0.2.0.",
      null,
      false,
      false,
    ],
    [
      "restarting a tip download",
      status("idle", { currentVersion: "v0.15.0-tip.3" }),
      null,
      none,
      { install: "v0.15.0-tip.3" },
      "restarting",
      "Installing and restarting…",
      "Code Foundry will reopen in a moment on v0.15.0 (tip 3).",
      null,
      false,
      false,
    ],
    ["disabled", status("idle", { enabled: false, disabledReason: "dev build" }), "dev", none, null, "disabled", "Updates are off for this build", "Dev build.", null, true, false],
  ])("%s", (_name, st, gui, threads, restarting, variant, title, body, later, close, showBusy) => {
    const v = updateView(st, gui, threads, restarting);
    expect(v.variant).toBe(variant);
    expect(v.title).toBe(title);
    expect(v.body).toBe(body);
    expect(v.later).toBe(later);
    expect(v.close).toBe(close);
    expect(v.showBusy).toBe(showBusy);
  });

  it("every variant except upToDate and disabled closes through the later link, not ×", () => {
    const views = [
      updateView(status("installed"), null, none),
      updateView(status("available"), null, none),
      updateView(status("downloading"), null, none),
      updateView(status("downloaded"), null, none),
      updateView(status("downloaded"), null, { busy: 1 }),
      updateView(status("failed"), null, none),
      updateView(status("idle"), "v0.2.0", none),
    ];
    for (const v of views) {
      expect(v.close).toBe(false);
      expect(v.later).not.toBeNull();
    }
  });

  // The primary button's label (null: none). The component maps the variant to its action.
  it.each<[string, UpdateStatusView, string | null, ThreadActivity, Restarting | null, string | null]>([
    ["available", status("available"), null, none, null, "Download v0.2.0"],
    ["available tip", status("available", { targetVersion: "v0.15.0-tip.3" }), null, none, null, "Download v0.15.0 (tip 3)"],
    ["downloading", status("downloading"), null, none, null, null],
    ["downloaded", status("downloaded"), null, none, null, "Install and Restart Now"],
    ["downloaded, busy", status("downloaded"), null, { busy: 2 }, null, "Install and Restart Now"],
    ["installed", status("installed"), null, none, null, "Restart Now"],
    ["restart required, busy", status("restartRequired"), null, { busy: 1 }, null, "Restart Now"],
    ["partly applied", status("idle"), "v0.2.0", none, null, "Restart Now"],
    ["failed", status("failed"), null, none, null, "Try Again"],
    ["up to date", status("idle"), null, none, null, "Check Again"],
    ["restarting", status("installed"), null, none, { install: "v0.2.0" }, null],
    ["disabled", status("idle", { enabled: false }), null, none, null, null],
  ])("primary: %s", (_name, st, gui, threads, restarting, want) => {
    expect(updateView(st, gui, threads, restarting).primary).toBe(want);
  });

  it("partly applied carries both versions", () => {
    expect(updateView(status("idle"), "v0.2.0", none).mismatch).toEqual({ app: "v0.2.0", daemon: "v0.1.0", version: "v0.2.0" });
  });
});

describe("busyHeading", () => {
  it.each([
    [1, "1 thread would be cut off"],
    [2, "2 threads would be cut off"],
  ])("%d", (n, want) => {
    expect(busyHeading(n)).toBe(want);
  });
});

describe("cutOffLabel (a busy thread's row)", () => {
  it.each<[CutOff, number, number, string]>([
    ["working", 0, 0, "working"],
    ["waiting", 0, 0, "waiting on you"],
    ["reporting", 0, 0, "reporting finished work"],
    ["background", 1, 0, "1 background agent"],
    ["background", 2, 0, "2 background agents"],
    ["background", 0, 1, "1 background shell"],
    ["background", 2, 1, "2 background agents and 1 shell"],
    ["background", 1, 3, "1 background agent and 3 shells"],
  ])("%s %i %i", (kind, agents, shells, want) => {
    expect(cutOffLabel(kind, agents, shells)).toBe(want);
  });
});

describe("failureHeadline", () => {
  it.each([
    ["installer: exit status 1: error: checksum mismatch", "Installer exited with status 1"],
    ["gh: HTTP 403: API rate limit exceeded", "Installer failed"],
  ])("%s", (reason, want) => {
    expect(failureHeadline(reason)).toBe(want);
  });
});
