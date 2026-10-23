import { CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeScope } from "@/components/themes/ThemeScope";
import { SLOTS, type SlotGroup } from "@/themes/slots";
import type { Theme } from "@/themes";

/**
 * Each status tone's classes, whole (dynamic class names cannot be read by Tailwind or the
 * guards). A solid badge only where the app paints text on the fill (warning: the attention
 * badge; error: destructive buttons); the other -foreground slots are pages-only.
 */
const TONE: Readonly<Record<string, { chip: string; dot: string; solid?: string }>> = {
  success: { chip: "bg-cf-success-surface text-cf-success-text", dot: "text-cf-success" },
  warning: { chip: "bg-cf-warning-surface text-cf-warning-text", dot: "text-cf-warning", solid: "bg-cf-warning text-cf-warning-foreground" },
  error: { chip: "bg-cf-error-surface text-cf-error-text", dot: "text-cf-error", solid: "bg-cf-error text-cf-error-foreground" },
  info: { chip: "bg-cf-info-surface text-cf-info-text", dot: "text-cf-info" },
  highlight: { chip: "bg-cf-highlight-surface text-cf-highlight-text", dot: "text-cf-highlight" },
  update: { chip: "bg-cf-update-surface text-cf-update-text", dot: "text-cf-update" },
};

const groupOf = new Map<string, SlotGroup>(SLOTS.map((s) => [s.name, s.group]));

/** Which sample shows a slot: the surface it sits on (a sidebar row, a status chip, text on a pane), or a generic one. */
function sampleKind(slot: string): "sidebar" | "status" | "text" | "generic" {
  const g = groupOf.get(slot);
  if (g === "sidebar") return "sidebar";
  if (g === "status") return "status";
  if (g === "text") return "text";
  return "generic";
}

/**
 * A slot painted where it sits, in `theme` (the draft for "Yours", the draft without the
 * pin for "Derived"): a sidebar row for sidebar slots, a chip, a dot and a solid badge for
 * status slots, text on a pane for text slots, and for the rest a block and a line in the
 * slot's colour on a pane.
 */
export function SlotSample({ theme, slot, className }: { theme: Theme; slot: string; className?: string }) {
  const kind = sampleKind(slot);
  return (
    <ThemeScope theme={theme} className={cn("overflow-hidden rounded-md border border-cf-divider", className)}>
      {kind === "sidebar" && (
        <div className="space-y-0.5 bg-cf-sidebar p-1.5" data-testid="slot-sample-sidebar">
          <div className="rounded-sm bg-cf-sidebar-row-selected px-2 py-1">
            <p className="truncate text-body-sm text-cf-sidebar-foreground">Tide-pool theme</p>
            <p className="truncate text-caption-sm text-cf-sidebar-muted-foreground">Finished</p>
          </div>
          <div className="rounded-sm bg-cf-sidebar-row-hover px-2 py-1">
            <p className="truncate text-body-sm text-cf-sidebar-foreground">Merge fixes</p>
          </div>
        </div>
      )}
      {kind === "status" && <StatusSample slot={slot} />}
      {kind === "text" && (
        <div className="space-y-0.5 bg-cf-surface px-2 py-1.5" data-testid="slot-sample-text">
          <p className="truncate text-body-sm text-cf-text">Body text on a pane</p>
          <p className="truncate text-caption text-cf-text-secondary">secondary · <span className="text-cf-text-muted">muted</span></p>
          <p className="truncate text-body-sm text-cf-link underline">a link</p>
        </div>
      )}
      {kind === "generic" && (
        <div className="flex items-center gap-2 bg-cf-surface px-2 py-1.5" data-testid="slot-sample-generic">
          <span className="size-6 shrink-0 rounded-sm border border-cf-divider" style={{ background: `var(${slot})` }} />
          <span className="truncate text-body-sm" style={{ color: `var(${slot})` }}>
            Aa text
          </span>
        </div>
      )}
    </ThemeScope>
  );
}

function StatusSample({ slot }: { slot: string }) {
  const tone = /^--cf-(success|warning|error|info|highlight|update)/.exec(slot)?.[1] ?? "info";
  const c = TONE[tone] ?? TONE.info;
  if (!c) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 bg-cf-surface px-2 py-1.5" data-testid="slot-sample-status">
      <CircleDot className={cn("size-3.5", c.dot)} aria-hidden />
      <span className={cn("rounded-sm px-1.5 py-0.5 text-caption-sm font-medium", c.chip)}>Finished</span>
      {c.solid && <span className={cn("rounded-full px-1.5 text-caption-sm font-medium", c.solid)}>3</span>}
    </div>
  );
}
