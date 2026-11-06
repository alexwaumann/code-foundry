import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** A filter chip: pressed or not. `sm` is a group header's. */
export function Chip({ label, on, onClick, testId, size = "md" }: { label: string; on: boolean; onClick: () => void; testId: string; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border border-cf-border px-2 outline-none hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus dark:hover:bg-cf-control-hover/50",
        size === "sm" ? "h-5 text-caption-sm" : "h-6 text-body-sm",
        on ? "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50" : "text-cf-text-muted",
      )}
      onClick={onClick}
      data-testid={testId}
      data-on={on || undefined}
    >
      {on && <Check className="size-3" aria-hidden />}
      {label}
    </button>
  );
}
