import { useMemo } from "react";
import { Download, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { updateBadge, type UpdateBadge, type UpdateBadgeKind } from "@/lib/update";
import { cn } from "@/lib/utils";
import { openUpdateDialog, useUpdateStore } from "@/stores/update";

/** Each kind of pending update's look, shared by the expanded footer's chip and the rail's tile. */
const tone: Record<UpdateBadgeKind, { className: string; icon: LucideIcon }> = {
  available: { className: "bg-cf-update-surface text-cf-update-text hover:bg-cf-update/15", icon: Download },
  downloading: { className: "bg-cf-update-surface text-cf-update-text hover:bg-cf-update/15", icon: Download },
  downloaded: { className: "bg-cf-success-surface text-cf-success-text hover:bg-cf-success/15", icon: RefreshCw },
  failed: { className: "bg-cf-error-surface text-cf-error-text hover:bg-cf-error/15", icon: TriangleAlert },
  installed: { className: "bg-cf-success-surface text-cf-success-text hover:bg-cf-success/15", icon: RefreshCw },
};

/** The pending update's badge (lib/update updateBadge), or null while there is nothing to say. */
function useUpdateBadge(): UpdateBadge | null {
  const status = useUpdateStore((s) => s.status);
  const guiVersion = useUpdateStore((s) => s.guiVersion);
  const oldDaemon = useUpdateStore((s) => s.oldDaemon);
  return useMemo(() => updateBadge(status, guiVersion, oldDaemon), [status, guiVersion, oldDaemon]);
}

/**
 * Sidebar status row: a full-width chip for a pending update ("v0.2.0 available ·
 * Download", "v0.2.0 downloaded · Restart to apply", …); opens the update dialog.
 */
export function UpdateIndicator() {
  const badge = useUpdateBadge();
  if (!badge) return null;
  const { className, icon: Icon } = tone[badge.kind];
  return (
    <button
      type="button"
      className={cn("mb-1 flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-md pr-[9px] pl-2 text-left text-caption-sm font-medium transition-colors", className)}
      onClick={() => {
        openUpdateDialog();
      }}
      data-testid="update-indicator"
      data-kind={badge.kind}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" data-testid="update-indicator-label">
        {badge.label}
      </span>
      {badge.cta && (
        <span className="ml-auto shrink-0 font-normal opacity-80" data-testid="update-indicator-cta">
          {badge.cta}
        </span>
      )}
    </button>
  );
}

/**
 * The chip on the collapsed sidebar's rail (docs/notes/sidebar-rail.md): a tile with the chip's
 * icon in its tone, no text; the chip's words (the label, then the call to action) are its
 * tooltip, beside the rail. A click does what the chip does.
 */
export function UpdateTile() {
  const badge = useUpdateBadge();
  if (!badge) return null;
  const { className, icon: Icon } = tone[badge.kind];
  const name = badge.cta ? `${badge.label} · ${badge.cta}` : badge.label;
  return (
    <Tip
      side="right"
      data-testid="update-tile-tip"
      label={
        <span className="flex items-baseline gap-2.5 whitespace-nowrap">
          <span className="font-medium">{badge.label}</span>
          {badge.cta && <span className="opacity-70">{badge.cta}</span>}
        </span>
      }
    >
      <button
        type="button"
        aria-label={name}
        className={cn("mb-1 flex h-[26px] w-7 shrink-0 items-center justify-center rounded-md transition-colors", className)}
        onClick={() => {
          openUpdateDialog();
        }}
        data-testid="update-tile"
        data-kind={badge.kind}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
      </button>
    </Tip>
  );
}
