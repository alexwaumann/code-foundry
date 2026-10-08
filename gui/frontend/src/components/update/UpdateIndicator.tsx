import { useMemo } from "react";
import { updateBadge, type UpdateBadgeKind } from "@/lib/update";
import { cn } from "@/lib/utils";
import { openUpdateDialog, useUpdateStore } from "@/stores/update";

const tone: Record<UpdateBadgeKind, string> = {
  available: "text-sky-400",
  downloading: "text-sky-400",
  failed: "text-red-400",
  relaunch: "text-emerald-400",
  restart: "text-amber-400",
};

/** Sidebar status row: "update ready v0.2.0", "relaunch to apply", …; opens the update dialog. */
export function UpdateIndicator() {
  const status = useUpdateStore((s) => s.status);
  const guiVersion = useUpdateStore((s) => s.guiVersion);
  const badge = useMemo(() => updateBadge(status, guiVersion), [status, guiVersion]);
  if (!badge) return null;
  return (
    <button
      type="button"
      className={cn("min-w-0 truncate text-left hover:underline", tone[badge.kind])}
      onClick={() => {
        openUpdateDialog();
      }}
      data-testid="update-indicator"
      data-kind={badge.kind}
      title="Software update"
    >
      {badge.label}
    </button>
  );
}
