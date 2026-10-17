import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { appInfo, onCheckForUpdatesMenu, relaunchApp } from "@/api/app";
import { invokeCommand, isUnknownCommand } from "@/api/command";
import { errorMessage } from "@/api/stream";
import type { UpdateEventView, UpdateStatusView } from "@/api/update";
import type { Restarting } from "@/lib/update";
import { invokeConfirmed, refreshCommands, useCommandsStore } from "./commands";
import { getUiContext } from "./context";
import { restartCutsOff } from "@/lib/thread";
import { useSessionsStore } from "./threads";

export type UpdateAction = "check" | "download" | "relaunch" | "restart";

interface UpdateSlice {
  /** The daemon's updater status (from the events stream); null until the first event. */
  status: UpdateStatusView | null;
  /** The window shell's own version; null outside Wails. */
  guiVersion: string | null;
  dialogOpen: boolean;
  /** An action the dialog started and is waiting on. */
  pending: UpdateAction | null;
  /**
   * Restart Now succeeded: the dialog shows "Restarting…" ("Installing and restarting…"
   * when it installed a download) until the window goes away. null before.
   */
  restarting: Restarting | null;
  error: string | null;
}

export const useUpdateStore = create<UpdateSlice>()(() => ({
  status: null,
  guiVersion: null,
  dialogOpen: false,
  pending: null,
  restarting: null,
  error: null,
}));

/** Events-stream reducer for the update source. */
export function applyUpdateEvent(ev: UpdateEventView): void {
  if (ev.kind === "relaunch") {
    // Inside the app the Wails host follows relaunch requests itself (gui/relaunch.go).
    void appInfo().then((app) => {
      if (!app) toast.info("Relaunch requested", { description: "Reopen the app to run the installed version." });
    });
    return;
  }
  const prev = useUpdateStore.getState().status;
  useUpdateStore.setState({ status: ev.status });
  // app.update's availability and title ("Download vX") and app.restart's ("Install vX
  // and Restart") follow the state.
  if (prev?.state !== ev.status.state || prev.targetVersion !== ev.status.targetVersion) void refreshCommands();
}

/**
 * Ids of the threads a restart cuts off (working, waiting on the user or running background work; restartCutsOff:
 * the daemon's own count), in sidebar order.
 */
export function useCutOffThreadIds(): string[] {
  return useSessionsStore(
    useShallow((s) => {
      const ids: string[] = [];
      for (const id of s.order) {
        const x = s.byId[id];
        if (x && restartCutsOff(x) !== null) ids.push(id);
      }
      return ids;
    }),
  );
}

export function openUpdateDialog(opts: { check?: boolean } = {}): void {
  useUpdateStore.setState({ dialogOpen: true, error: null });
  if (opts.check) void runUpdateAction("check");
}

export function closeUpdateDialog(): void {
  useUpdateStore.setState({ dialogOpen: false, pending: null, restarting: null, error: null });
}

const actionCommands: Record<Exclude<UpdateAction, "restart">, string> = {
  check: "app.update.check",
  download: "app.update",
  relaunch: "app.relaunch",
};

/**
 * Restart Now: app.restart installs a downloaded update, closes the sessions, asks the
 * window host to relaunch once the daemon has exited, and exits. The dialog is the confirmation, so it goes in with
 * confirmed set (no second confirm dialog). A daemon older than app.restart (absent
 * from the command list, or NotFound) gets daemon.restart and the host's own Relaunch.
 */
async function restartApp(): Promise<void> {
  const ctx = getUiContext();
  const commands = useCommandsStore.getState().commands;
  const known = commands.length === 0 || commands.some((c) => c.name === "app.restart");
  if (known) {
    try {
      await invokeCommand("app.restart", ctx, {}, undefined, { confirmed: true });
      return;
    } catch (err) {
      if (!isUnknownCommand(err)) throw err;
    }
  }
  await invokeCommand("daemon.restart", ctx, {}, undefined, { confirmed: true });
  // Without a host (browser dev) there is nothing to relaunch; the page reconnects.
  void relaunchApp().catch((err: unknown) => {
    console.warn("relaunch", err);
  });
}

/**
 * Runs an update action through the registry (like every user action). The dialog
 * renders progress from the status events; errors land in the dialog, not a toast.
 * Restart switches the dialog to "Restarting…" and keeps it open: the window goes away.
 */
export async function runUpdateAction(action: UpdateAction): Promise<boolean> {
  useUpdateStore.setState({ pending: action, error: null });
  try {
    if (action === "restart") {
      // Read before the call: the daemon has moved on (installed) by the time it returns.
      const st = useUpdateStore.getState().status;
      const install = st?.state === "downloaded" ? st.targetVersion : "";
      await restartApp();
      useUpdateStore.setState({ restarting: { install }, dialogOpen: true });
      return true;
    }
    const res = await invokeConfirmed(actionCommands[action], {}, getUiContext());
    if (!res) return false;
    if (action === "relaunch" && res.message.startsWith("no app window")) toast.info(res.message);
    return true;
  } catch (err) {
    useUpdateStore.setState({ error: errorMessage(err) });
    return false;
  } finally {
    useUpdateStore.setState((s) => (s.pending === action ? { pending: null } : {}));
    void refreshCommands();
  }
}

/** Loads the GUI's own version and wires the app menu's "Check for Updates…". */
export function startUpdateSync(): () => void {
  appInfo()
    .then((info) => {
      useUpdateStore.setState({ guiVersion: info?.version ?? null });
    })
    .catch(() => undefined);
  return onCheckForUpdatesMenu(() => {
    openUpdateDialog({ check: true });
  });
}
