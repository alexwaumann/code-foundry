import { Button } from "@/components/ui/button";
import { runLegacyImport, skipLegacyImport, useLegacyImportStore } from "@/shell/legacyImport";

/**
 * What the pane area shows while the window shell cannot draw yet (components/shell/Shell.tsx):
 * the first-load import failed (what happened, Try again, Open without them), or the daemon has
 * not sent a layout in a while (a daemon from before the shell gets the update dialog's Restart
 * Now over this; lib/update.ts SHELL_SINCE). Drawn as one pane, like the empty space.
 */
export function ShellNotice({ kind }: { kind: "import-failed" | "no-layout" }) {
  const error = useLegacyImportStore((s) => s.error);
  const running = useLegacyImportStore((s) => s.phase === "running");
  return (
    <main className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-pane border border-cf-divider bg-cf-surface p-6 shadow-xs" data-testid="shell-notice" data-notice={kind}>
      {kind === "import-failed" ? (
        <div className="flex max-w-md flex-col gap-3">
          <h2 className="text-heading text-cf-text">Your old panels could not be brought over</h2>
          <p className="text-body text-cf-text-muted">
            The side panel tabs and bottom terminals of the previous window were not moved into this one. Nothing is lost: your threads are all here, and running terminals keep running.
          </p>
          {error && (
            <p className="text-body-sm break-words text-cf-text-muted" data-testid="shell-notice-error">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={running} onClick={() => void runLegacyImport()} data-testid="shell-import-retry">
              {running ? "Trying again…" : "Try again"}
            </Button>
            <Button size="sm" variant="outline" disabled={running} onClick={skipLegacyImport} data-testid="shell-import-skip">
              Open without them
            </Button>
          </div>
          <p className="text-caption text-cf-text-muted">Opened without them, the app tries again the next time it starts.</p>
        </div>
      ) : (
        <p className="text-body text-cf-text-muted">Waiting for the daemon to send this window&apos;s layout…</p>
      )}
    </main>
  );
}
