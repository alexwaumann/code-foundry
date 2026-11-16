import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A strip's box in the dock, above the composer; thread.css `.dock-strip` spaces it from what follows. */
export const DOCK_STRIP = "dock-strip min-w-0 overflow-hidden rounded-lg border border-cf-border bg-cf-surface-raised text-body-sm";

export const DOCK_STRIP_ICON = "size-3.5 shrink-0 text-cf-text-muted";

/**
 * A strip's one line: its icon, its sentence (the whole of it in a tooltip once cut short), then its actions on the right.
 * `toneClass` colours the icon and the sentence (a woken thread's warning); muted icon and plain text otherwise.
 */
export function DockStripLine({ icon: Icon, sentence, testId, toneClass, children }: { icon: LucideIcon; sentence: string; testId: string; toneClass?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-1.5 pr-2 pl-3">
      <Icon className={cn(DOCK_STRIP_ICON, toneClass)} aria-hidden />
      <Tip label={sentence} whenTruncated>
        <span className={cn("min-w-0 flex-1 truncate", toneClass)} role="status" data-testid={testId}>
          {sentence}
        </span>
      </Tip>
      {children}
    </div>
  );
}
