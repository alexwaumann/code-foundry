/**
 * A daemon with no window layout (docs/notes/shell-24d-spec-differences.md, 5). The layout comes
 * only as the events stream's layout source, which a daemon from before the shell does not have:
 * its stream works and simply never sends one, so nothing fails and the window would wait for
 * ever. A daemon whose version predates the shell gets the update dialog (lib/update.ts
 * SHELL_SINCE), but a locally built one reports "dev", which never counts as older.
 *
 * So while the window waits, it asks for the layout itself (LayoutService.Get). A daemon without
 * the service answers Unimplemented (the tunnel hands the call to the daemon's mux, whose 404 for
 * an unknown service connect-web reads as Unimplemented: api/errors.ts isOutdatedDaemon), and the
 * waiting text becomes a notice that the daemon predates this window, with Restart Now: app.restart
 * stops the daemon and the window host relaunches the app, whose connect starts the daemon binary
 * it ships with. A daemon that has the service answers with the layout, which is applied as the
 * snapshot it is.
 */
import { create } from "zustand";
import { relaunchApp } from "@/api/app";
import { isUnknownCommand } from "@/api/command";
import { isOutdatedDaemon } from "@/api/errors";
import { getLayout } from "@/api/layout";
import { errorMessage, isAbort } from "@/api/stream";
import { invokeConfirmed } from "@/stores/commands";
import { getUiContext } from "@/stores/context";
import { applyImportedLayout } from "@/stores/layout";

interface LayoutServiceState {
  /** The daemon answered that it has no LayoutService: it predates the window shell. */
  missing: boolean;
  /** Restart Now was confirmed and sent; the app goes away and comes back. */
  restarting: boolean;
  /** Why Restart Now failed; "" otherwise. */
  error: string;
}

export const useLayoutServiceStore = create<LayoutServiceState>()(() => ({ missing: false, restarting: false, error: "" }));

/** What one ask found: the service is missing, there (its layout applied), or nothing was learned (a failed call). */
export type LayoutProbe = "missing" | "present" | "unknown";

/** Asks the daemon for its layout once (see the file comment). `get` sends it (tests). */
export async function probeLayoutService(get: typeof getLayout = getLayout): Promise<LayoutProbe> {
  try {
    const layout = await get();
    useLayoutServiceStore.setState({ missing: false });
    applyImportedLayout(layout);
    return "present";
  } catch (err) {
    if (isAbort(err) || !isOutdatedDaemon(err)) return "unknown";
    useLayoutServiceStore.setState({ missing: true });
    return "missing";
  }
}

/** Forgets what the probe found (a layout arrived; tests). */
export function resetLayoutService(): void {
  useLayoutServiceStore.setState({ missing: false, restarting: false, error: "" });
}

/**
 * Restart Now on the notice: app.restart, after the daemon's own confirmation (it names what a
 * restart cuts off). A daemon older than app.restart gets daemon.restart and the host's Relaunch,
 * as the update dialog does (stores/update.ts restartApp). Declining changes nothing.
 */
export async function restartOldDaemon(): Promise<void> {
  const s = useLayoutServiceStore.getState();
  if (s.restarting) return;
  useLayoutServiceStore.setState({ error: "" });
  const ctx = getUiContext();
  try {
    let res;
    try {
      res = await invokeConfirmed("app.restart", {}, ctx);
    } catch (err) {
      if (!isUnknownCommand(err)) throw err;
      res = await invokeConfirmed("daemon.restart", {}, ctx);
      if (res)
        void relaunchApp().catch((e: unknown) => {
          console.warn("relaunch", e);
        });
    }
    if (res) useLayoutServiceStore.setState({ restarting: true });
  } catch (err) {
    useLayoutServiceStore.setState({ error: errorMessage(err) });
  }
}
