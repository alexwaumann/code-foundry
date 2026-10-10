import { useMemo } from "react";
import { Download, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { updateBadge, type UpdateBadgeKind } from "@/lib/update";
import { cn } from "@/lib/utils";
import { openUpdateDialog, useUpdateStore } from "@/stores/update";

const tone: Record<UpdateBadgeKind, { className: string; icon: LucideIcon }> = {
  available: { className: "bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 dark:bg-sky-400/10 dark:text-sky-400 dark:hover:bg-sky-400/15", icon: Download },
  downloading: { className: "bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 dark:bg-sky-400/10 dark:text-sky-400 dark:hover:bg-sky-400/15", icon: Download },
  failed: { className: "bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:bg-red-400/10 dark:text-red-400 dark:hover:bg-red-400/15", icon: TriangleAlert },
  installed: { className: "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:bg-emerald-400/10 dark:text-emerald-400 dark:hover:bg-emerald-400/15", icon: RefreshCw },
};

/**
 * Sidebar status row: a full-width chip for a pending update ("v0.2.0 available ·
 * Install", "v0.2.0 installed · Restart to apply", …); opens the update dialog.
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
      className={cn("mb-1 flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-md pr-[9px] pl-2 text-left text-[11px] font-medium transition-colors", className)}
      onClick={() => {
        openUpdateDialog();
      }}
      data-testid="update-indicator"
      data-kind={badge.kind}
      title="Software update"
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
