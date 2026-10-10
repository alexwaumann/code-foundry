import type { ReactNode } from "react";
import { useMemo } from "react";
import { Download, ExternalLink, Loader2, RefreshCw, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { openExternal } from "@/api/app";
import type { UpdateStatusView } from "@/api/update";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatAgo } from "@/lib/session";
import { busyHeading, failureHeadline, updateView, type UpdateVariant, type UpdateView } from "@/lib/update";
import { cn } from "@/lib/utils";
import { closeUpdateDialog, runUpdateAction, useBusyThreadNames, useLiveSessionCount, useUpdateStore, type UpdateAction } from "@/stores/update";

const linkTone = "text-sky-700 hover:underline dark:text-sky-400";

interface Primary {
  action: UpdateAction;
  label: (v: UpdateView) => string;
  icon?: LucideIcon;
  outline?: boolean;
}

const restart: Primary = { action: "restart", label: () => "Restart Now", icon: RefreshCw };

/** The one full-width button per variant (none while installing, restarting, or disabled). */
const primaries: Partial<Record<UpdateVariant, Primary>> = {
  readyIdle: restart,
  readyBusy: restart,
  readyOpen: restart,
  partlyApplied: restart,
  available: { action: "install", label: (v) => `Install ${v.version}`, icon: Download },
  failed: { action: "install", label: () => "Try Again" },
  upToDate: { action: "check", label: () => "Check Again", outline: true },
};

function checked(st: UpdateStatusView): string {
  return st.lastCheckedAt ? `Checked ${formatAgo(st.lastCheckedAt.getTime())}` : "Not checked yet";
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
  readyIdle: (st) => [`Running ${st.currentVersion}`, <NotesLink key="n" url={st.notesUrl} />],
  readyBusy: (st) => [`Running ${st.currentVersion}`, <NotesLink key="n" url={st.notesUrl} />],
  readyOpen: (st) => [`Running ${st.currentVersion}`, <NotesLink key="n" url={st.notesUrl} />],
  available: (st) => [checked(st), <NotesLink key="n" url={st.notesUrl} />],
  upToDate: (st) => [checked(st), <RepoLink key="r" repo={st.releaseRepo} />],
  partlyApplied: (_st, v) => (v.mismatch ? [`App ${v.mismatch.app}`, `Daemon ${v.mismatch.daemon}`] : []),
  restarting: () => ["Stopping daemon"],
};

function Meta({ items }: { items: ReactNode[] }) {
  const shown = items.filter((x) => x !== null && x !== "");
  if (shown.length === 0) return null;
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-muted-foreground" data-testid="update-meta">
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
  );
}

function ProgressBar({ className }: { className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-sm bg-foreground/10", className)} role="progressbar" aria-busy>
      <div className="h-full w-1/3 animate-[cf-indeterminate_1.4s_ease-in-out_infinite] rounded-sm bg-foreground" />
    </div>
  );
}

/** The busy threads a restart would cut off mid-turn. */
function BusyThreads() {
  const names = useBusyThreadNames();
  if (names.length === 0) return null;
  return (
    <div className="mx-auto mt-3.5 max-w-[330px] rounded-lg border border-pane-border px-3 py-2 text-left text-xs" data-testid="update-busy-threads">
      <div className="mb-1 flex items-center gap-[7px] font-medium text-amber-700 dark:text-amber-400" data-testid="update-busy-heading">
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
        {busyHeading(names.length)}
      </div>
      {names.map((name, i) => (
        <div key={i} className="flex gap-1.5" data-testid="update-busy-thread">
          <span className="min-w-0 truncate text-foreground">{name}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">working</span>
        </div>
      ))}
    </div>
  );
}

function Failure({ reason }: { reason: string }) {
  return (
    <div className="mt-3.5 flex gap-[9px] rounded-lg bg-red-500/10 px-3 py-2.5 text-left text-xs">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
      <div className="min-w-0">
        {failureHeadline(reason)}
        <pre className="mt-[3px] max-h-32 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground select-text" data-testid="update-failure">
          {reason}
        </pre>
      </div>
    </div>
  );
}

function PrimaryButton({ p, v }: { p: Primary; v: UpdateView }) {
  const pending = useUpdateStore((s) => s.pending);
  const checking = useUpdateStore((s) => s.status?.checking ?? false);
  const busy = pending === p.action || (p.action === "check" && checking);
  const Icon = busy ? Loader2 : p.icon;
  return (
    <Button
      variant={p.outline ? "outline" : "default"}
      className="h-8 w-full gap-[7px] rounded-[7px] text-[13px] [&_svg:not([class*='size-'])]:size-3.5"
      disabled={pending !== null || busy}
      onClick={() => void runUpdateAction(p.action)}
      data-testid={`update-${p.action}`}
    >
      {Icon && <Icon className={cn(busy && "animate-spin")} aria-hidden />}
      {p.label(v)}
    </Button>
  );
}

function LaterLink({ label }: { label: string }) {
  return (
    <button type="button" className="mx-auto text-[12.5px] text-muted-foreground hover:text-foreground" onClick={closeUpdateDialog} data-testid="update-later">
      {label}
    </button>
  );
}

function Body({ st, v }: { st: UpdateStatusView; v: UpdateView }) {
  const error = useUpdateStore((s) => s.error);
  const primary = primaries[v.variant];
  const meta = metas[v.variant]?.(st, v) ?? [];
  const checkError = st.lastCheckError && (v.variant === "upToDate" || v.variant === "available") ? st.lastCheckError : "";
  return (
    <>
      <DialogDescription className="mx-auto mt-1.5 max-w-[330px] text-[12.5px] text-muted-foreground">{v.body}</DialogDescription>
      {v.showBusy && <BusyThreads />}
      {v.variant === "failed" && <Failure reason={st.failureReason} />}
      {v.variant === "installing" && (
        <>
          <ProgressBar className="mt-[18px]" />
          <p className="mt-[7px] truncate text-left font-mono text-[11.5px] text-muted-foreground" data-testid="update-progress">
            {st.progress}
          </p>
        </>
      )}
      {v.variant === "restarting" && <ProgressBar className="mt-4" />}
      {checkError && (
        <p className="mt-3 text-[11.5px] text-amber-700 dark:text-amber-400" data-testid="update-check-error">
          Last check failed: {checkError}
        </p>
      )}
      {error && (
        <p className="mt-3 text-[11.5px] break-words text-red-600 dark:text-red-400" data-testid="update-error">
          {error}
        </p>
      )}
      {(primary || v.later) && (
        <div className={cn("grid gap-2.5", primary ? "mt-[18px]" : "mt-3.5")}>
          {primary && <PrimaryButton p={primary} v={v} />}
          {v.later && <LaterLink label={v.later} />}
        </div>
      )}
      <Meta items={meta} />
    </>
  );
}

/**
 * Software update, centred on the app icon: one primary action per state (Install,
 * Restart Now, Try Again, Check Again), a muted link that closes, and a meta line.
 * Only "up to date" (and "updates are off") has a ×; every other state closes through
 * its Later / Hide / Not now link. Variants and copy: lib/update.ts updateView.
 */
export function UpdateDialog() {
  const open = useUpdateStore((s) => s.dialogOpen);
  const st = useUpdateStore((s) => s.status);
  const guiVersion = useUpdateStore((s) => s.guiVersion);
  const restarting = useUpdateStore((s) => s.restarting);
  const live = useLiveSessionCount();
  const busy = useBusyThreadNames().length;
  const v = useMemo(() => (st ? updateView(st, guiVersion, { live, busy }, restarting) : null), [st, guiVersion, live, busy, restarting]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeUpdateDialog();
      }}
    >
      <DialogContent
        className="max-w-[400px] rounded-[10px] border-pane-border px-6 pt-[26px] pb-[18px] text-center text-[13px] leading-[1.45]"
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
        <img src="/appicon.png" alt="" className="mx-auto mb-3 block size-16 rounded-[15px]" draggable={false} />
        <DialogTitle className="text-[15px] font-semibold" data-testid="update-state">
          {v?.title ?? "Waiting for the daemon…"}
        </DialogTitle>
        {st && v ? <Body st={st} v={v} /> : <DialogDescription className="sr-only">Software update</DialogDescription>}
      </DialogContent>
    </Dialog>
  );
}
