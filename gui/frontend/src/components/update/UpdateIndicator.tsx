import { useMemo } from "react";
import { Download, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { updateBadge, type UpdateBadgeKind } from "@/lib/update";
import { cn } from "@/lib/utils";
import { openUpdateDialog, useUpdateStore } from "@/stores/update";

const tone: Record<UpdateBadgeKind, { className: string; icon: LucideIcon }> = {
  available: { className: "bg-cf-info-surface text-cf-info hover:bg-cf-info/15", icon: Download },
  downloading: { className: "bg-cf-info-surface text-cf-info hover:bg-cf-info/15", icon: Download },
  downloaded: { className: "bg-cf-success-surface text-cf-success hover:bg-cf-success/15", icon: RefreshCw },
  failed: { className: "bg-cf-error-surface text-cf-error hover:bg-cf-error/15", icon: TriangleAlert },
  installed: { className: "bg-cf-success-surface text-cf-success hover:bg-cf-success/15", icon: RefreshCw },
};

/**
 * Sidebar status row: a full-width chip for a pending update ("v0.2.0 available ·
 * Download", "v0.2.0 downloaded · Restart to apply", …); opens the update dialog.
 */
export function UpdateIndicator() {
  const status = useUpdateStore((s) => s.status);
  const guiVersion = useUpdateStore((s) => s.guiVersion);
  const badge = useMemo(() => updateBadge(status, guiVersion), [status, guiVersion]);
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
