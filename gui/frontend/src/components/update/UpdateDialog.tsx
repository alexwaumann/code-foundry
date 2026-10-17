import type { ReactNode } from "react";
import { useMemo } from "react";
import { Download, ExternalLink, Loader2, RefreshCw, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { openExternal } from "@/api/app";
import type { UpdateStatusView } from "@/api/update";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { formatAgo, restartCutsOff } from "@/lib/thread";
import { busyHeading, cutOffLabel, displayVersion, failureHeadline, updateView, type UpdateVariant, type UpdateView } from "@/lib/update";
import { cn } from "@/lib/utils";
import { useSessionsStore } from "@/stores/threads";
import { closeUpdateDialog, runUpdateAction, useCutOffThreadIds, useUpdateStore, type UpdateAction } from "@/stores/update";

const linkTone = "text-link hover:underline";

/** What a variant's primary button does; its label is the view's (UpdateView.primary). */
interface Primary {
  action: UpdateAction;
  icon?: LucideIcon;
  outline?: boolean;
}

// Restart Now / Install and Restart Now: app.restart installs a download itself.
const restart: Primary = { action: "restart", icon: RefreshCw };

/** The one full-width button per variant (none while downloading, restarting, or disabled). */
const primaries: Partial<Record<UpdateVariant, Primary>> = {
  readyIdle: restart,
  readyBusy: restart,
  partlyApplied: restart,
  available: { action: "download", icon: Download },
  failed: { action: "download" },
  upToDate: { action: "check", outline: true },
};

function checked(st: UpdateStatusView): string {
  return st.lastCheckedAt ? `Checked ${formatAgo(st.lastCheckedAt.getTime())}` : "Not checked yet";
}

/** "Running v0.15.0 (tip 3) · tip channel". */
function running(st: UpdateStatusView): string {
  return `Running ${displayVersion(st.currentVersion)} · ${st.channel} channel`;
}

function NotesLink({ url }: { url: string }) {
  if (!url) return null;
  return (
    <button type="button" className={cn("inline-flex items-center gap-[3px]", linkTone)} onClick={() => void openExternal(url).catch(() => undefined)} data-testid="update-notes">
      Release notes <ExternalLink className="size-[11px]" aria-hidden />
    </button>
  );
}

function RepoLink({ repo }: { repo: string }) {
  if (!repo) return null;
  return (
    <button type="button" className="hover:text-foreground hover:underline" onClick={() => void openExternal(`https://github.com/${repo}`).catch(() => undefined)}>
      github.com/{repo}
    </button>
  );
}

/** The 11px line at the foot of the dialog, per variant. */
const metas: Partial<Record<UpdateVariant, (st: UpdateStatusView, v: UpdateView) => ReactNode[]>> = {
  readyIdle: (st) => [running(st), <NotesLink key="n" url={st.notesUrl} />],
  readyBusy: (st) => [running(st), <NotesLink key="n" url={st.notesUrl} />],
  available: (st) => [checked(st), <NotesLink key="n" url={st.notesUrl} />],
  upToDate: (st) => [checked(st), <RepoLink key="r" repo={st.releaseRepo} />],
  partlyApplied: (_st, v) => (v.mismatch ? [`App ${displayVersion(v.mismatch.app)}`, `Daemon ${displayVersion(v.mismatch.daemon)}`] : []),
  restarting: () => ["Stopping daemon"],
};

/** A line above the meta line where the line itself has no room for the running version and channel. */
const leads: Partial<Record<UpdateVariant, (st: UpdateStatusView) => string>> = {
  available: running,
  upToDate: running,
};

function Meta({ items, lead }: { items: ReactNode[]; lead: string }) {
  const shown = items.filter((x) => x !== null && x !== "");
  if (shown.length === 0 && !lead) return null;
  return (
    <div className="mt-4 grid gap-1 text-caption-sm" data-testid="update-meta">
      {lead && <div data-testid="update-meta-lead">{lead}</div>}
      {shown.length > 0 && (
        <div className="flex items-center justify-center gap-2">
          {shown.map((x, i) => (
            <span key={i} className="contents">
              {i > 0 && (
                <span className="opacity-50" aria-hidden>
                  |
                </span>
              )}
              {typeof x === "string" ? <span>{x}</span> : x}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}


/** One thread a restart would cut off: its name, and what it loses (cutOffLabel). */
function BusyThread({ id }: { id: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name || "Untitled thread");
  const label = useSessionsStore((s) => {
    const x = s.byId[id];
    const kind = x ? restartCutsOff(x) : null;
    return x && kind ? cutOffLabel(kind, x.backgroundAgentsRunning, x.backgroundShellsRunning) : "";
  });
  return (
    <div className="flex gap-1.5" data-testid="update-busy-thread">
      <span className="min-w-0 truncate text-foreground">{name}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">{label}</span>
    </div>
  );
}

/** The threads a restart would cut off (the daemon's count: working, waiting on the user, background work). */
function BusyThreads() {
  const ids = useCutOffThreadIds();
  if (ids.length === 0) return null;
  return (
    <div className="mx-auto mt-3.5 max-w-[330px] rounded-lg border border-pane-border px-3 py-2 text-left text-body-sm" data-testid="update-busy-threads">
      <div className="mb-1 flex items-center gap-[7px] font-medium text-warning" data-testid="update-busy-heading">
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
        {busyHeading(ids.length)}
      </div>
      {ids.map((id) => (
        <BusyThread key={id} id={id} />
      ))}
    </div>
  );
}

function Failure({ reason }: { reason: string }) {
  return (
    <div className="mt-3.5 flex gap-[9px] rounded-lg bg-destructive/10 px-3 py-2.5 text-left text-body-sm">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0">
        {failureHeadline(reason)}
        <pre className="mt-[3px] max-h-32 overflow-auto text-caption-sm font-mono break-words whitespace-pre-wrap select-text" data-testid="update-failure">
          {reason}
        </pre>
      </div>
    </div>
  );
}

function PrimaryButton({ p, label }: { p: Primary; label: string }) {
  const pending = useUpdateStore((s) => s.pending);
  const checking = useUpdateStore((s) => s.status?.checking ?? false);
  const busy = pending === p.action || (p.action === "check" && checking);
  const Icon = busy ? Loader2 : p.icon;
  return (
    <Button
      variant={p.outline ? "outline" : "default"}
      className="h-8 w-full gap-[7px] rounded-md [&_svg:not([class*='size-'])]:size-3.5"
      disabled={pending !== null || busy}
      onClick={() => void runUpdateAction(p.action)}
      data-testid={`update-${p.action}`}
    >
      {Icon && <Icon className={cn(busy && "animate-spin")} aria-hidden />}
      {label}
    </Button>
  );
}

function LaterLink({ label }: { label: string }) {
  return (
    <button type="button" className="mx-auto text-caption hover:text-foreground" onClick={closeUpdateDialog} data-testid="update-later">
      {label}
    </button>
  );
}

function Body({ st, v }: { st: UpdateStatusView; v: UpdateView }) {
  const error = useUpdateStore((s) => s.error);
  const primary = v.primary === null ? undefined : primaries[v.variant];
  const meta = metas[v.variant]?.(st, v) ?? [];
  const checkError = st.lastCheckError && (v.variant === "upToDate" || v.variant === "available") ? st.lastCheckError : "";
  return (
    <>
      <DialogDescription className="mx-auto mt-1.5 max-w-[330px]">{v.body}</DialogDescription>
      {v.showBusy && <BusyThreads />}
      {v.variant === "failed" && <Failure reason={st.failureReason} />}
      {v.variant === "downloading" && (
        <>
          <Progress className="mt-[18px] h-1" aria-label="Downloading the update" data-testid="update-progress-bar" />
          <p className="mt-[7px] truncate text-left text-caption-sm font-mono" data-testid="update-progress">
            {st.progress}
          </p>
        </>
      )}
      {v.variant === "restarting" && <Progress className="mt-4 h-1" aria-label="Restarting" data-testid="update-progress-bar" />}
      {checkError && (
        <p className="mt-3 text-caption-sm text-warning" data-testid="update-check-error">
          Last check failed: {checkError}
        </p>
      )}
      {error && (
        <p className="mt-3 text-caption-sm break-words text-destructive" data-testid="update-error">
          {error}
        </p>
      )}
      {(primary || v.later) && (
        <div className={cn("grid gap-2.5", primary ? "mt-[18px]" : "mt-3.5")}>
          {primary && v.primary !== null && <PrimaryButton p={primary} label={v.primary} />}
          {v.later && <LaterLink label={v.later} />}
        </div>
      )}
      <Meta items={meta} lead={leads[v.variant]?.(st) ?? ""} />
    </>
  );
}

/**
 * Software update, centred on the app icon: one primary action per state (Download,
 * Install and Restart Now, Restart Now, Try Again, Check Again), a muted link that
 * closes, and a meta line.
 * Only "up to date" (and "updates are off") has a ×; every other state closes through
 * its Later / Hide / Not now link. Variants and copy: lib/update.ts updateView.
 */
export function UpdateDialog() {
  const open = useUpdateStore((s) => s.dialogOpen);
  const st = useUpdateStore((s) => s.status);
  const guiVersion = useUpdateStore((s) => s.guiVersion);
  const restarting = useUpdateStore((s) => s.restarting);
  const busy = useCutOffThreadIds().length;
  const v = useMemo(() => (st ? updateView(st, guiVersion, { busy }, restarting) : null), [st, guiVersion, busy, restarting]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeUpdateDialog();
      }}
    >
      <DialogContent
        className="max-w-[400px] border-pane-border px-6 pt-[26px] pb-[18px] text-center text-body-sm"
        data-testid="update-dialog"
        data-state-name={st?.state ?? "unknown"}
        data-variant={v?.variant ?? "waiting"}
      >
        {v?.close && (
          <button
            type="button"
            className="absolute top-3 right-3 grid size-[22px] place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={closeUpdateDialog}
            aria-label="Close"
            data-testid="update-close"
          >
            <X className="size-[13px]" aria-hidden />
          </button>
        )}
        <img src="/appicon.png" alt="" className="mx-auto mb-3 block size-16 rounded-2xl" draggable={false} />
        <DialogTitle data-testid="update-state">
          {v?.title ?? "Waiting for the daemon…"}
        </DialogTitle>
        {st && v ? <Body st={st} v={v} /> : <DialogDescription className="sr-only">Software update</DialogDescription>}
      </DialogContent>
    </Dialog>
  );
}
