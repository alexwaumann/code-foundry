import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Info } from "lucide-react";

/**
 * A tab body with nothing to show as code: a missing file, a folder, a binary, a diff the
 * daemon cannot compute. Centred icon, a title, a muted line (often the path), then
 * buttons.
 */
export function FileEmptyState({ icon: Icon, heading, detail, children, testId }: { icon: LucideIcon; heading: string; detail?: ReactNode; children?: ReactNode; testId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid={testId}>
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-subheading">{heading}</p>
      {detail && <p className="max-w-full text-caption break-all">{detail}</p>}
      {children && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}

/** A one-line notice above the body (truncated contents). */
export function NoticeBar({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-pane-border bg-muted/50 px-3 py-1 text-caption-sm" data-testid={testId}>
      <Info className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/** The body while the first read runs. */
export function FileLoading() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-caption" data-testid="file-loading">
      Loading…
    </div>
  );
}
