import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { UpdateStatusView } from "@/api/update";

const invokeCommand = vi.hoisted(() => vi.fn(() => Promise.resolve({ message: "ok", resultJson: "" })));
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const relaunchApp = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/api/app", async (orig) => ({ ...(await orig<typeof import("@/api/app")>()), relaunchApp }));

const getUpdateStatus = vi.hoisted(() => vi.fn());
vi.mock("@/api/update", async (orig) => ({ ...(await orig<typeof import("@/api/update")>()), getUpdateStatus }));

const { useCommandsStore } = await import("./commands");
const { useHealthStore } = await import("./health");
const { applyUpdateEvent, isOldDaemon, runUpdateAction, startUpdateSync, useUpdateStore } = await import("./update");
const { presentCommand } = await import("@/keys/bindings");

function cmd(name: string): CommandView {
  return { name } as CommandView;
}

function calls(): [string, boolean | undefined][] {
  return (invokeCommand.mock.calls as unknown as [string, unknown, unknown, unknown, { confirmed?: boolean } | undefined][]).map((c) => [c[0], c[4]?.confirmed]);
}

beforeEach(() => {
  useUpdateStore.setState({ status: null, dialogOpen: true, pending: null, restarting: null, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
  useCommandsStore.setState({ commands: [] });
});

describe("runUpdateAction('restart')", () => {
  it("invokes app.restart confirmed (no confirm dialog) and switches to Restarting", async () => {
    useCommandsStore.setState({ commands: [cmd("app.restart"), cmd("daemon.restart")] });
    await expect(runUpdateAction("restart")).resolves.toBe(true);
    expect(calls()).toEqual([["app.restart", true]]);
    expect(relaunchApp).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({ restarting: { install: "" }, dialogOpen: true, pending: null, error: null });
  });

  it("from downloaded, remembers the version app.restart installs (the status moves on before it returns)", async () => {
    useCommandsStore.setState({ commands: [cmd("app.restart")] });
    useUpdateStore.setState({ status: { state: "downloaded", targetVersion: "v0.2.0" } as UpdateStatusView });
    invokeCommand.mockImplementationOnce(() => {
      useUpdateStore.setState({ status: { state: "installed", targetVersion: "v0.2.0" } as UpdateStatusView });
      return Promise.resolve({ message: "installed v0.2.0; restarting Code Foundry", resultJson: "" });
    });
    await expect(runUpdateAction("restart")).resolves.toBe(true);
    expect(calls()).toEqual([["app.restart", true]]);
    expect(useUpdateStore.getState().restarting).toEqual({ install: "v0.2.0" });
  });

  it("from installed it only restarts", async () => {
    useCommandsStore.setState({ commands: [cmd("app.restart")] });
    useUpdateStore.setState({ status: { state: "installed", targetVersion: "v0.2.0" } as UpdateStatusView });
    await expect(runUpdateAction("restart")).resolves.toBe(true);
    expect(useUpdateStore.getState().restarting).toEqual({ install: "" });
  });

  it("an older daemon without app.restart: daemon.restart confirmed, then the host relaunches", async () => {
    useCommandsStore.setState({ commands: [cmd("daemon.restart")] });
    await expect(runUpdateAction("restart")).resolves.toBe(true);
    expect(calls()).toEqual([["daemon.restart", true]]);
    expect(relaunchApp).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().restarting).toEqual({ install: "" });
  });

  it("with no command list yet, tries app.restart and falls back on NotFound", async () => {
    invokeCommand.mockRejectedValueOnce(new ConnectError('unknown command "app.restart"', Code.NotFound));
    await expect(runUpdateAction("restart")).resolves.toBe(true);
    expect(calls()).toEqual([
      ["app.restart", true],
      ["daemon.restart", true],
    ]);
    expect(relaunchApp).toHaveBeenCalledTimes(1);
  });

  it("other failures land in the dialog and do not restart", async () => {
    useCommandsStore.setState({ commands: [cmd("app.restart")] });
    invokeCommand.mockRejectedValueOnce(new ConnectError("install v0.2.0: installer: exit status 1", Code.FailedPrecondition));
    await expect(runUpdateAction("restart")).resolves.toBe(false);
    expect(calls()).toEqual([["app.restart", true]]);
    expect(relaunchApp).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({ restarting: null, error: "install v0.2.0: installer: exit status 1" });
  });
});

describe("runUpdateAction('download')", () => {
  it("invokes app.update (UpdateService.Download in the daemon)", async () => {
    await expect(runUpdateAction("download")).resolves.toBe(true);
    expect(calls().map((c) => c[0])).toEqual(["app.update"]);
    expect(useUpdateStore.getState()).toMatchObject({ pending: null, error: null, restarting: null });
  });
});

// The palette's two update entries (e2e update.spec.ts used to run them through cmd+k).
describe("the update commands' presenters", () => {
  beforeEach(() => {
    useUpdateStore.setState({ dialogOpen: false });
  });

  it("app.update.check opens the dialog and checks", async () => {
    expect(presentCommand("app.update.check")).toBe(true);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().pending).toBeNull();
    });
    expect(calls().map((c) => c[0])).toEqual(["app.update.check"]);
  });

  it("app.update opens the dialog and downloads", async () => {
    expect(presentCommand("app.update")).toBe(true);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().pending).toBeNull();
    });
    expect(calls().map((c) => c[0])).toEqual(["app.update"]);
  });
});

describe("applyUpdateEvent", () => {
  const st = (state: UpdateStatusView["state"], targetVersion: string) => ({ state, targetVersion }) as UpdateStatusView;

  // The daemon titles app.update ("Download v0.2.0") and app.restart ("Install v0.2.0 and
  // Restart") from the state (internal/command/commands_update_test.go); the palette re-lists.
  it("re-lists the commands when the state or the target changes, not on a repeat", () => {
    useUpdateStore.setState({ status: st("idle", "") });
    applyUpdateEvent({ kind: "status", status: st("available", "v0.2.0") });
    expect(useUpdateStore.getState().status?.state).toBe("available");
    expect(listCommands).toHaveBeenCalledTimes(1);
    applyUpdateEvent({ kind: "status", status: st("available", "v0.2.0") });
    expect(listCommands).toHaveBeenCalledTimes(1);
    applyUpdateEvent({ kind: "status", status: st("available", "v0.3.0") });
    expect(listCommands).toHaveBeenCalledTimes(2);
    applyUpdateEvent({ kind: "status", status: st("downloaded", "v0.3.0") });
    expect(listCommands).toHaveBeenCalledTimes(3);
  });
});

describe("a daemon from before the tunnel", () => {
  const seen = (version: string) => {
    useHealthStore.setState({ status: "ok", health: { pid: 1, version, uptimeSeconds: 1 }, error: null });
  };
  const old = { state: "available", currentVersion: "v0.21.5" } as UpdateStatusView;
  let stop: () => void;

  beforeEach(() => {
    useUpdateStore.setState({ status: null, dialogOpen: false, oldDaemon: false });
    useHealthStore.setState({ status: "connecting", health: null, error: null });
    getUpdateStatus.mockResolvedValue(old);
    stop = startUpdateSync();
  });
  afterEach(() => {
    stop();
  });

  it("asks for the status by a call, since no event will bring it, and opens the dialog", async () => {
    seen("v0.21.5");
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().dialogOpen).toBe(true);
    });
    expect(useUpdateStore.getState()).toMatchObject({ oldDaemon: true, status: old });
  });

  it("opens the dialog once, so Later stays closed through the next pings", async () => {
    seen("v0.21.5");
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().dialogOpen).toBe(true);
    });
    useUpdateStore.setState({ dialogOpen: false });
    seen("v0.21.5");
    await Promise.resolve();
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
    expect(getUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it("asks again on the next ping after a failed call", async () => {
    getUpdateStatus.mockRejectedValueOnce(new Error("no"));
    seen("v0.21.5");
    await vi.waitFor(() => {
      expect(getUpdateStatus).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    await Promise.resolve();
    seen("v0.21.5");
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().dialogOpen).toBe(true);
    });
  });

  it.each(["v0.22.0-tip.3", "v0.22.0", "dev", "mock"])("leaves %s alone", async (version) => {
    seen(version);
    await Promise.resolve();
    expect(useUpdateStore.getState()).toMatchObject({ oldDaemon: false, dialogOpen: false });
    expect(getUpdateStatus).not.toHaveBeenCalled();
  });

  it("clears, and closes its dialog, once a restart brings a daemon this window can follow", async () => {
    seen("v0.21.5");
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().dialogOpen).toBe(true);
    });
    seen("v0.22.0");
    expect(useUpdateStore.getState()).toMatchObject({ oldDaemon: false, dialogOpen: false });
  });
});

// The window shell has no fallback (docs/notes/shell-20-cutover.md): a daemon with the tunnel but
// without the layout gets the same dialog, with Restart Now. The classic window (?shell=0) can
// still follow it.
describe("a daemon from before the window layout", () => {
  const old = { state: "available", currentVersion: "v0.21.5" } as UpdateStatusView;
  const seen = (version: string) => {
    useHealthStore.setState({ status: "ok", health: { pid: 1, version, uptimeSeconds: 1 }, error: null });
  };
  let stop: () => void;

  beforeEach(() => {
    useUpdateStore.setState({ status: null, dialogOpen: false, oldDaemon: false });
    useHealthStore.setState({ status: "connecting", health: null, error: null });
    getUpdateStatus.mockResolvedValue({ ...old, state: "idle", currentVersion: "v0.21.8-tip.2" });
  });
  afterEach(() => {
    stop();
  });

  it("opens the update dialog in the shell window", async () => {
    stop = startUpdateSync();
    seen("v0.21.8-tip.2");
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().dialogOpen).toBe(true);
    });
    expect(useUpdateStore.getState().oldDaemon).toBe(true);
  });

  it.each([
    ["v0.21.5", true],
    ["v0.21.8-tip.2", true],
    ["v0.22.0-tip.3", false],
    ["dev", false],
  ])("isOldDaemon(%s): %s", (version, want) => {
    expect(isOldDaemon(version)).toBe(want);
  });
});
