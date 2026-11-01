import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { UpdateStateView, UpdateStatusView } from "@/api/update";

// The dialog and the sidebar chip over the update store; the daemon's status arrives as
// store updates (the events stream), the actions go through the registry (invokeCommand).
const invokeCommand = vi.hoisted(() => vi.fn(() => Promise.resolve({ message: "ok", resultJson: "" })));
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));
vi.mock("@/api/app", async (orig) => ({
  ...(await orig<typeof import("@/api/app")>()),
  appInfo: () => Promise.resolve(null),
  openExternal: vi.fn(() => Promise.resolve()),
  relaunchApp: vi.fn(() => Promise.resolve(true)),
}));

const { UpdateDialog } = await import("./UpdateDialog");
const { UpdateIndicator } = await import("./UpdateIndicator");
const { useUpdateStore, useCutOffThreadIds } = await import("@/stores/update");
const { useThreadsStore } = await import("@/stores/threads");
const { useCommandsStore } = await import("@/stores/commands");

function status(state: UpdateStateView, over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    state,
    currentVersion: "v0.1.0",
    enabled: true,
    disabledReason: "",
    releaseRepo: "alexwaumann/code-foundry",
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

type Activity = Pick<ThreadView, "state" | "status" | "statusReason">;
const working: Activity = { state: "connected", status: "busy", statusReason: "" };
const waiting: Activity = { state: "connected", status: "attention", statusReason: "permission:Bash" };
const finished: Activity = { state: "connected", status: "attention", statusReason: "finished" };
const idle: Activity = { state: "connected", status: "idle", statusReason: "" };
// Stopped while waiting on a permission: its prompt went with the process.
const stoppedWaiting: Activity = { state: "stopped", status: "attention", statusReason: "permission:Bash" };

function thread(id: string, name: string, a: Activity): ThreadView {
  return { id, name, ...a, backgroundAgentsRunning: 0, backgroundShellsRunning: 0, backgroundWakePending: false } as ThreadView;
}

function setThreads(list: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id) });
}

function setStatus(st: UpdateStatusView): void {
  act(() => {
    useUpdateStore.setState({ status: st });
  });
}

function show(st: UpdateStatusView, open = true) {
  useUpdateStore.setState({ status: st, dialogOpen: open });
  render(
    <>
      <UpdateIndicator />
      <UpdateDialog />
    </>,
  );
}

const dialog = () => screen.getByTestId("update-dialog");
const q = (id: string) => within(dialog()).queryByTestId(id);
const text = (id: string) => within(dialog()).getByTestId(id).textContent;
const chip = () => {
  const el = screen.queryByTestId("update-indicator");
  if (!el) return null;
  return [el.dataset.kind, within(el).getByTestId("update-indicator-label").textContent, within(el).queryByTestId("update-indicator-cta")?.textContent ?? null];
};
const calls = () => (invokeCommand.mock.calls as unknown as [string, unknown, unknown, unknown, { confirmed?: boolean } | undefined][]).map((c) => [c[0], c[4]?.confirmed ?? false]);

beforeEach(() => {
  useUpdateStore.setState({ status: null, guiVersion: null, dialogOpen: false, pending: null, restarting: null, error: null });
  useCommandsStore.setState({ commands: [] });
  setThreads([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useCutOffThreadIds", () => {
  it("counts working and waiting threads in sidebar order, not finished, idle or stopped ones", () => {
    setThreads([thread("a", "A", finished), thread("b", "B", waiting), thread("c", "C", idle), thread("d", "D", working), thread("e", "E", stoppedWaiting)]);
    let ids: string[] = [];
    function Probe() {
      ids = useCutOffThreadIds();
      return null;
    }
    render(<Probe />);
    expect(ids).toEqual(["b", "d"]);
  });
});

describe("UpdateDialog", () => {
  it("up to date: Check Again, when it checked and the repo; × is the only close", () => {
    show(status("idle", { lastCheckedAt: new Date() }));
    expect(chip()).toBeNull();
    expect(dialog().dataset.variant).toBe("upToDate");
    expect(text("update-state")).toBe("You’re up to date");
    expect(dialog().textContent).toContain("Code Foundry v0.1.0 is the latest version.");
    expect(text("update-check")).toBe("Check Again");
    expect(text("update-meta")).toContain("Checked just now");
    expect(text("update-meta")).toContain("github.com/alexwaumann/code-foundry");
    expect(q("update-later")).toBeNull();
    fireEvent.click(within(dialog()).getByTestId("update-close"));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("available: Download, release notes and Later; the chip offers it; Download runs app.update", async () => {
    show(status("available", { notesUrl: "https://example.com/notes" }));
    expect(chip()).toEqual(["available", "v0.2.0 available", "Download"]);
    expect(dialog().dataset.variant).toBe("available");
    expect(text("update-state")).toBe("Code Foundry v0.2.0 is available");
    expect(dialog().textContent).toContain("You’re on v0.1.0. Downloading happens in the background and changes nothing until you restart.");
    expect(text("update-download")).toBe("Download v0.2.0");
    expect(text("update-notes")?.trim()).toBe("Release notes");
    expect(text("update-later")).toBe("Later");
    expect(q("update-close")).toBeNull();
    fireEvent.click(within(dialog()).getByTestId("update-download"));
    await waitFor(() => {
      expect(calls()).toEqual([["app.update", false]]);
    });
    fireEvent.click(within(dialog()).getByTestId("update-later"));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("the chip opens the dialog", () => {
    show(status("installed"), false);
    expect(screen.queryByTestId("update-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("update-indicator"));
    expect(dialog().dataset.variant).toBe("readyIdle");
  });

  it("downloading: the installer's line under a sliding bar, Hide, a chip without a button", () => {
    show(status("downloading", { progress: "==> downloading code-foundry_v0.2.0_darwin_arm64.tar.gz" }));
    expect(dialog().dataset.stateName).toBe("downloading");
    expect(dialog().dataset.variant).toBe("downloading");
    expect(text("update-state")).toBe("Downloading v0.2.0…");
    expect(dialog().textContent).toContain("You can close this and keep working. Nothing changes on disk until you install and restart.");
    expect(text("update-progress")).toContain("==>");
    const bar = within(dialog()).getByRole("progressbar", { name: "Downloading the update" });
    expect(bar.dataset.state).toBe("indeterminate");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(q("update-download")).toBeNull();
    expect(text("update-later")).toBe("Hide");
    expect(chip()).toEqual(["downloading", "Downloading v0.2.0…", null]);
  });

  it("downloaded with busy threads names them, follows them live, and Install and Restart Now runs app.restart confirmed", async () => {
    setThreads([thread("s-1", "Refactor sidebar tree", finished), thread("s-2", "Port renderer", waiting), thread("j-1", "Job 1", working), thread("j-2", "Job 2", working), thread("s-5", "Idle one", idle)]);
    show(status("downloaded", { notesUrl: "https://example.com/notes" }));
    expect(dialog().dataset.stateName).toBe("downloaded");
    expect(dialog().dataset.variant).toBe("readyBusy");
    expect(text("update-state")).toBe("Code Foundry v0.2.0 is ready");
    expect(dialog().textContent).toContain("Restarting now cuts these threads off. Let them finish first, or install and restart anyway: they keep their history, and a message continues each.");
    expect(dialog().textContent).not.toMatch(/connect/);
    const box = within(dialog()).getByTestId("update-busy-threads");
    expect(within(box).getByTestId("update-busy-heading").textContent).toBe("3 threads would be cut off");
    expect(within(box).getAllByTestId("update-busy-thread").map((r) => r.textContent)).toEqual(["Port rendererwaiting on you", "Job 1working", "Job 2working"]);
    expect(text("update-later")).toBe("Wait, I’ll restart later");
    expect(text("update-meta")).toContain("Running v0.1.0");
    expect(q("update-close")).toBeNull();
    expect(text("update-restart")).toBe("Install and Restart Now");
    expect(chip()).toEqual(["downloaded", "v0.2.0 downloaded", "Restart to apply"]);

    // Another busy thread shows up live.
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", "Refactor sidebar tree", working) } }));
    });
    expect(within(box).getByTestId("update-busy-heading").textContent).toBe("4 threads would be cut off");
    expect(box.textContent).toContain("Refactor sidebar tree");

    // The dialog is the confirmation: one confirmed app.restart, no second question.
    useCommandsStore.setState({ commands: [{ name: "app.restart" } as never, { name: "daemon.restart" } as never] });
    fireEvent.click(within(dialog()).getByTestId("update-restart"));
    await waitFor(() => {
      expect(dialog().dataset.variant).toBe("restarting");
    });
    expect(calls()).toEqual([["app.restart", true]]);
    expect(text("update-state")).toBe("Installing and restarting…");
    expect(dialog().textContent).toContain("Code Foundry will reopen in a moment on v0.2.0.");
    expect(text("update-meta")).toBe("Stopping daemon");
    expect(within(dialog()).queryAllByRole("button")).toHaveLength(0);
    // Back as the installed version: nothing pending, no chip.
    setStatus(status("idle", { currentVersion: "v0.2.0" }));
    expect(chip()).toBeNull();
  });

  it("downloaded with nothing running says nothing will be interrupted", () => {
    setThreads([thread("s-1", "A", finished), thread("s-2", "B", stoppedWaiting)]);
    show(status("downloaded"));
    expect(dialog().dataset.variant).toBe("readyIdle");
    expect(dialog().textContent).toContain(
      "Install and restart to finish updating. The app and the daemon update together, so nothing ends up out of sync. No thread is working or waiting on you, so nothing will be interrupted.",
    );
    expect(q("update-busy-threads")).toBeNull();
    expect(text("update-restart")).toBe("Install and Restart Now");
    expect(text("update-later")).toBe("Later");
  });

  it("installed with threads idle or stopped (one stopped while waiting) says nothing will be interrupted", () => {
    setThreads([thread("s-1", "A", finished), thread("s-2", "Port renderer", stoppedWaiting), thread("s-5", "C", idle)]);
    show(status("installed"));
    expect(chip()).toEqual(["installed", "v0.2.0 installed", "Restart to apply"]);
    expect(dialog().dataset.variant).toBe("readyIdle");
    expect(dialog().textContent).toContain("Restart to finish updating. No thread is working or waiting on you, so nothing will be interrupted.");
    expect(dialog().textContent).not.toMatch(/connect|open/);
    expect(q("update-busy-threads")).toBeNull();
    expect(text("update-restart")).toBe("Restart Now");
    expect(text("update-later")).toBe("Later");
    fireEvent.click(within(dialog()).getByTestId("update-later"));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("a failed download shows the reason; Try Again downloads again", async () => {
    show(status("failed", { failureReason: "installer: exit status 1: error: checksum mismatch" }));
    expect(dialog().dataset.variant).toBe("failed");
    expect(text("update-failure")).toBe("installer: exit status 1: error: checksum mismatch");
    expect(text("update-state")).toBe("Couldn’t update to v0.2.0");
    expect(dialog().textContent).toContain("Nothing changed. You’re still on v0.1.0.");
    expect(dialog().textContent).toContain("Installer exited with status 1");
    expect(text("update-download")).toBe("Try Again");
    expect(text("update-later")).toBe("Not now");
    expect(q("update-close")).toBeNull();
    expect(chip()).toEqual(["failed", "Update failed", "Details"]);
    fireEvent.click(within(dialog()).getByTestId("update-download"));
    await waitFor(() => {
      expect(calls()).toEqual([["app.update", false]]);
    });
    setStatus(status("downloaded"));
    expect(dialog().dataset.stateName).toBe("downloaded");
    expect(dialog().dataset.variant).toMatch(/^ready/);
    expect(text("update-restart")).toBe("Install and Restart Now");
  });

  it("disabled: updates are off, with the reason and a ×; no chip", () => {
    show(status("idle", { enabled: false, disabledReason: "dev build", currentVersion: "dev" }));
    expect(text("update-state")).toBe("Updates are off for this build");
    expect(dialog().textContent).toContain("Dev build.");
    expect(q("update-close")).not.toBeNull();
    expect(chip()).toBeNull();
  });
});
