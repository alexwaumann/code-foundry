import { create } from "zustand";
import { toast } from "sonner";
import { appInfo, onCheckForUpdatesMenu } from "@/api/app";
import { invokeCommand } from "@/api/command";
import { errorMessage } from "@/api/stream";
import type { UpdateEventView, UpdateStatusView } from "@/api/update";
import { refreshCommands } from "./commands";
import { getUiContext } from "./context";
import { useSessionsStore } from "./sessions";

export type UpdateAction = "check" | "install" | "relaunch" | "restart";

interface UpdateSlice {
  /** The daemon's updater status (from the events stream); null until the first event. */
  status: UpdateStatusView | null;
  /** The window shell's own version; null outside Wails. */
  guiVersion: string | null;
  dialogOpen: boolean;
  /** The dialog is asking to confirm a daemon restart. */
  confirmRestart: boolean;
  /** An action the dialog started and is waiting on. */
  pending: UpdateAction | null;
  error: string | null;
}

export const useUpdateStore = create<UpdateSlice>()(() => ({
  status: null,
  guiVersion: null,
  dialogOpen: false,
  confirmRestart: false,
  pending: null,
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
  // app.update's availability and title ("Update to vX") follow the state.
  if (prev?.state !== ev.status.state || prev.targetVersion !== ev.status.targetVersion) void refreshCommands();
}

/** Sessions with a running process: the ones a daemon restart closes. */
export function useLiveSessionCount(): number {
  return useSessionsStore((s) => Object.values(s.byId).filter((x) => x.state !== "disconnected").length);
}

export function openUpdateDialog(opts: { check?: boolean; confirmRestart?: boolean } = {}): void {
  useUpdateStore.setState({ dialogOpen: true, confirmRestart: opts.confirmRestart ?? false, error: null });
  if (opts.check) void runUpdateAction("check");
}

export function closeUpdateDialog(): void {
  useUpdateStore.setState({ dialogOpen: false, confirmRestart: false, pending: null, error: null });
}

const actionCommands: Record<UpdateAction, string> = {
  check: "app.update.check",
  install: "app.update",
  relaunch: "app.relaunch",
  restart: "daemon.restart",
};

/**
 * Runs an update command through the registry (like every user action). The dialog
 * renders progress from the status events; errors land in the dialog, not a toast.
 */
export async function runUpdateAction(action: UpdateAction): Promise<boolean> {
  useUpdateStore.setState({ pending: action, error: null });
  try {
    const res = await invokeCommand(actionCommands[action], getUiContext(), {});
    if (action === "restart") {
      toast.info("Restarting the daemon", { description: res.message });
      closeUpdateDialog();
    }
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
