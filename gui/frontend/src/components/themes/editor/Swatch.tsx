import { cn } from "@/lib/utils";

/** A checkerboard in the window's surface colours, under a tint so its alpha shows. */
export const CHECKER = "bg-[repeating-conic-gradient(var(--cf-surface-sunken)_0_25%,var(--cf-surface)_0_50%)] bg-size-[8px_8px]";

/** A colour's swatch: the colour over a checkerboard (a tint composites over it), bordered so a colour near the pane's shows. */
export function Swatch({ value, className }: { value: string | undefined; className?: string }) {
  return (
    <span className={cn("relative inline-block size-4 shrink-0 overflow-hidden rounded-sm border border-cf-border", CHECKER, className)} aria-hidden>
      {value && <span className="absolute inset-0" style={{ background: value }} />}
    </span>
  );
}
