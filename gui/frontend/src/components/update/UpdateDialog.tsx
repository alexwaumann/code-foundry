import type { ReactNode } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { openExternal } from "@/api/app";
import type { UpdateStatusView } from "@/api/update";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatAgo } from "@/lib/session";
import { compareVersions } from "@/lib/update";
import { closeUpdateDialog, runUpdateAction, useLiveSessionCount, useUpdateStore, type UpdateAction } from "@/stores/update";

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

function ActionButton({ action, children, variant = "default" }: { action: UpdateAction; children: ReactNode; variant?: "default" | "outline" | "destructive" }) {
  const pending = useUpdateStore((s) => s.pending);
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending !== null}
      onClick={() => void runUpdateAction(action)}
      data-testid={`update-${action}`}
    >
      {pending === action && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}

function NotesLink({ url, version }: { url: string; version: string }) {
  if (!url) return null;
  return (
    <button type="button" className="inline-flex items-center gap-1 text-sky-400 hover:underline" onClick={() => void openExternal(url).catch(() => undefined)} data-testid="update-notes">
      Release notes for {version} <ExternalLink className="size-3" aria-hidden />
    </button>
  );
}

/** Daemon restart: explains what closes; the registry's confirm dialog asks before it runs. */
function RestartSection() {
  const sessions = useLiveSessionCount();
  return (
    <section className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3" data-testid="update-restart-section">
      <p className="text-amber-300">
        Daemon restart pending; <span data-testid="restart-sessions">{plural(sessions, "session")}</span> will close.
      </p>
      <p className="text-xs text-muted-foreground">
        The daemon keeps running the old version, with your sessions, until it restarts. Closed sessions stay in the sidebar and can be reconnected.
      </p>
      <ActionButton action="restart" variant="outline">
        Restart daemon…
      </ActionButton>
    </section>
  );
}

function Body({ st, guiVersion }: { st: UpdateStatusView; guiVersion: string | null }) {
  const target = st.targetVersion;
  const guiStale = guiVersion !== null && compareVersions(guiVersion, target) === -1;
  if (!st.enabled) {
    return <p data-testid="update-state">Updates are disabled for this build ({st.disabledReason}).</p>;
  }
  switch (st.state) {
    case "available":
      return (
        <div className="space-y-3">
          <p data-testid="update-state">Code Foundry {target} is available. You have {st.currentVersion}.</p>
          <NotesLink url={st.notesUrl} version={target} />
          <div>
            <ActionButton action="install">Update to {target}</ActionButton>
          </div>
        </div>
      );
    case "downloading":
      return (
        <div className="space-y-2">
          <p data-testid="update-state">Installing {target}…</p>
          <div className="h-1 overflow-hidden rounded bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded bg-sky-500" />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" data-testid="update-progress">
            {st.progress}
          </p>
        </div>
      );
    case "failed":
      return (
        <div className="space-y-3">
          <p data-testid="update-state">Installing {target} failed.</p>
          <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap" data-testid="update-failure">
            {st.failureReason}
          </pre>
          <ActionButton action="install">Retry</ActionButton>
        </div>
      );
    case "installed":
    case "restartRequired":
      return (
        <div className="space-y-3">
          <p data-testid="update-state">{target} is installed.</p>
          {(st.state === "installed" || guiStale) && guiVersion !== target && (
            <section className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3" data-testid="update-relaunch-section">
              <p className="text-emerald-300">Ready: relaunch to apply.</p>
              <p className="text-xs text-muted-foreground">The window reopens on the new version. Sessions keep running.</p>
              <ActionButton action="relaunch">Relaunch</ActionButton>
            </section>
          )}
          <RestartSection />
        </div>
      );
    case "idle":
      return (
        <div className="space-y-3">
          <p data-testid="update-state">
            {st.checking ? "Checking for updates…" : st.lastCheckedAt ? `Code Foundry ${st.currentVersion} is up to date.` : `Code Foundry ${st.currentVersion}.`}
          </p>
          {guiVersion !== null && compareVersions(guiVersion, st.currentVersion) === -1 && (
            <section className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3" data-testid="update-relaunch-section">
              <p className="text-emerald-300">
                The daemon runs {st.currentVersion}; this window is {guiVersion}. Relaunch to apply.
              </p>
              <ActionButton action="relaunch">Relaunch</ActionButton>
            </section>
          )}
          <ActionButton action="check" variant="outline">
            Check now
          </ActionButton>
        </div>
      );
  }
}

/** Software update: notes link, install progress, result, relaunch and daemon restart. */
export function UpdateDialog() {
  const open = useUpdateStore((s) => s.dialogOpen);
  const st = useUpdateStore((s) => s.status);
  const guiVersion = useUpdateStore((s) => s.guiVersion);
  const error = useUpdateStore((s) => s.error);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeUpdateDialog();
      }}
    >
      <DialogContent className="max-w-md space-y-3 p-5 text-sm" data-testid="update-dialog" data-state-name={st?.state ?? "unknown"}>
        <DialogTitle>Software Update</DialogTitle>
        <DialogDescription className="text-xs">
          {st ? (
            <>
              Daemon {st.currentVersion}
              {guiVersion !== null && <> · app {guiVersion}</>}
              {st.releaseRepo && <> · from {st.releaseRepo}</>}
              {st.enabled && <> · checked {formatAgo(st.lastCheckedAt?.getTime() ?? null)}</>}
            </>
          ) : (
            "Waiting for the daemon…"
          )}
        </DialogDescription>
        {st && <Body st={st} guiVersion={guiVersion} />}
        {st?.lastCheckError && st.state !== "downloading" && (
          <p className="text-xs text-amber-400" data-testid="update-check-error">
            Last check failed: {st.lastCheckError}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-400" data-testid="update-error">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
