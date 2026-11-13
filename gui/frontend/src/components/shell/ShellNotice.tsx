import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useLayoutStore } from "@/stores/layout";
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

/** The line under the pane grid while the daemon keeps a newer build's layout in memory. */
export const NEWER_LAYOUT_TEXT = "This layout was saved by a newer version of Code Foundry. Changes to it are not saved until you update.";

/**
 * One quiet line under the pane grid when a newer build wrote the stored layout
 * (LayoutState.newerBuild): the daemon left it on disk as it was and works on what this build
 * understands of it in memory, so the user's changes to it last until the daemon stops
 * (docs/notes/shell-review-fixes-daemon.md, 7). Nothing is wrong with what is shown; no action.
 */
export function NewerLayoutLine() {
  const newer = useLayoutStore((s) => s.newerBuild);
  if (!newer) return null;
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 px-1 pt-1.5 text-cf-text-muted" data-testid="shell-newer-layout" role="status">
      <Info aria-hidden className="size-3 shrink-0" />
      <Tip label={NEWER_LAYOUT_TEXT} whenTruncated side="top">
        <span className="truncate text-caption">{NEWER_LAYOUT_TEXT}</span>
      </Tip>
    </div>
  );
}
