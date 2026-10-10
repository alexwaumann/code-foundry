import { describe, expect, it } from "vitest";
import type { UpdateStateView, UpdateStatusView } from "@/api/update";
import { busyHeading, compareVersions, failureHeadline, updateBadge, updateView, versionMismatch, type ThreadActivity, type UpdateVariant } from "./update";

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
  ])("%s", (_name, st, gui, want) => {
    expect(versionMismatch(st, gui)?.version ?? null).toBe(want);
  });
});

describe("updateBadge", () => {
  it.each<[string, UpdateStatusView | null, string | null, string | null, string | null]>([
    ["no status", null, "v0.1.0", null, null],
    ["idle", status("idle"), "v0.1.0", null, null],
    ["available", status("available"), "v0.1.0", "v0.2.0 available", "Install"],
    ["downloading", status("downloading"), "v0.1.0", "Installing v0.2.0…", ""],
    ["failed", status("failed"), "v0.1.0", "Update failed", "Details"],
    ["installed, old GUI", status("installed"), "v0.1.0", "v0.2.0 installed", "Restart to apply"],
    ["installed, GUI unknown (browser)", status("installed"), null, "v0.2.0 installed", "Restart to apply"],
    ["installed, GUI already relaunched", status("installed"), "v0.2.0", "v0.2.0 installed", "Restart to apply"],
    ["restart required", status("restartRequired"), "v0.2.0", "v0.2.0 installed", "Restart to apply"],
    ["partly applied: GUI newer, idle", status("idle"), "v0.2.0", "v0.2.0 installed", "Restart to apply"],
    ["partly applied: daemon restarted first", status("idle", { currentVersion: "v0.2.0" }), "v0.1.0", "v0.2.0 installed", "Restart to apply"],
    ["dev GUI against a release daemon", status("idle", { currentVersion: "v0.2.0" }), "dev", null, null],
    ["dev daemon, disabled", status("idle", { currentVersion: "dev", enabled: false }), "dev", null, null],
  ])("%s", (_name, st, gui, label, cta) => {
    const b = updateBadge(st, gui);
    expect(b?.label ?? null).toBe(label);
    expect(b?.cta ?? null).toBe(cta);
  });

  it("kinds", () => {
    expect(updateBadge(status("restartRequired"), null)?.kind).toBe("installed");
    expect(updateBadge(status("idle"), "v0.2.0")?.kind).toBe("installed");
    expect(updateBadge(status("failed"), null)?.kind).toBe("failed");
  });
});

const none: ThreadActivity = { live: 0, busy: 0 };

describe("updateView", () => {
  it.each<[string, UpdateStatusView, string | null, ThreadActivity, boolean, UpdateVariant, string, string, string | null, boolean, boolean]>([
    // name, status, gui, threads, restarting -> variant, title, body, later, close, showBusy
    ["ready, nothing running", status("installed"), "v0.1.0", none, false, "readyIdle", "Code Foundry v0.2.0 is ready", "Restart to finish updating. Nothing is running right now, so nothing will be interrupted.", "Later", false, false],
    [
      "ready, threads mid-turn",
      status("restartRequired"),
      null,
      { live: 3, busy: 2 },
      false,
      "readyBusy",
      "Code Foundry v0.2.0 is ready",
      "Restarting now cuts these threads off mid-turn. Let them finish first, or restart anyway: they keep their history and can be reconnected.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "ready, one thread mid-turn",
      status("installed"),
      null,
      { live: 1, busy: 1 },
      false,
      "readyBusy",
      "Code Foundry v0.2.0 is ready",
      "Restarting now cuts this thread off mid-turn. Let it finish first, or restart anyway: it keeps its history and can be reconnected.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "ready, threads open but none busy",
      status("installed"),
      null,
      { live: 3, busy: 0 },
      false,
      "readyOpen",
      "Code Foundry v0.2.0 is ready",
      "Restart to finish updating. 3 threads are open but none are working, so nothing will be interrupted. They’ll reconnect with their history.",
      "Later",
      false,
      false,
    ],
    [
      "ready, one thread open",
      status("installed"),
      null,
      { live: 1, busy: 0 },
      false,
      "readyOpen",
      "Code Foundry v0.2.0 is ready",
      "Restart to finish updating. 1 thread is open but it isn’t working, so nothing will be interrupted. It’ll reconnect with its history.",
      "Later",
      false,
      false,
    ],
    [
      "available",
      status("available"),
      "v0.1.0",
      none,
      false,
      "available",
      "Code Foundry v0.2.0 is available",
      "You’re on v0.1.0. Installing happens in the background; you’ll be asked to restart when it’s done.",
      "Later",
      false,
      false,
    ],
    ["installing", status("downloading"), "v0.1.0", none, false, "installing", "Installing v0.2.0…", "You can close this and keep working.", "Hide", false, false],
    ["up to date", status("idle"), "v0.1.0", { live: 2, busy: 1 }, false, "upToDate", "You’re up to date", "Code Foundry v0.1.0 is the latest version.", null, true, false],
    ["checking", status("idle", { checking: true }), null, none, false, "upToDate", "Checking for updates…", "Code Foundry v0.1.0 is the latest version.", null, true, false],
    [
      "partly applied: GUI newer, idle, busy threads",
      status("idle"),
      "v0.2.0",
      { live: 2, busy: 2 },
      false,
      "partlyApplied",
      "Code Foundry v0.2.0 is partly applied",
      "The app is on v0.2.0 but the daemon is still on v0.1.0; some things won’t work until you restart. Restarting now cuts these threads off mid-turn.",
      "Wait, I’ll restart later",
      false,
      true,
    ],
    [
      "partly applied: installed, GUI on target, nothing busy",
      status("installed"),
      "v0.2.0",
      { live: 1, busy: 0 },
      false,
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
      false,
      "partlyApplied",
      "Code Foundry v0.2.0 is partly applied",
      "The daemon is on v0.2.0 but the app is still on v0.1.0; some things won’t work until you restart.",
      "Later",
      false,
      false,
    ],
    ["failed", status("failed", { failureReason: "x" }), "v0.1.0", none, false, "failed", "Couldn’t install v0.2.0", "Nothing changed. You’re still on v0.1.0.", "Not now", false, false],
    ["restarting", status("idle", { currentVersion: "v0.2.0" }), "v0.1.0", { live: 2, busy: 1 }, true, "restarting", "Restarting…", "Code Foundry will reopen in a moment.", null, false, false],
    ["disabled", status("idle", { enabled: false, disabledReason: "dev build" }), "dev", none, false, "disabled", "Updates are off for this build", "Dev build.", null, true, false],
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
      updateView(status("failed"), null, none),
      updateView(status("idle"), "v0.2.0", none),
    ];
    for (const v of views) {
      expect(v.close).toBe(false);
      expect(v.later).not.toBeNull();
    }
  });

  it("partly applied carries both versions", () => {
    expect(updateView(status("idle"), "v0.2.0", none).mismatch).toEqual({ app: "v0.2.0", daemon: "v0.1.0", version: "v0.2.0" });
  });
});

describe("busyHeading", () => {
  it.each([
    [1, "1 thread is still working"],
    [2, "2 threads are still working"],
  ])("%d", (n, want) => {
    expect(busyHeading(n)).toBe(want);
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
