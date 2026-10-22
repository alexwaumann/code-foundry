import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { InlineView } from "../parts";
import type { NodeProps } from "../registry";

/** One operation's progress: label and meta over a 4 px track; no value is indeterminate. */
export function ProgressNode({ data }: NodeProps<"progress">) {
  const value = data.value === undefined ? null : Math.min(1, Math.max(0, data.value));
  const failed = data.tone === "error";
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="plugin-progress" data-value={value ?? undefined}>
      {(data.label || data.meta !== undefined) && (
        <div className="flex min-w-0 items-center gap-2 text-caption-sm">
          <span className={cn("min-w-0 flex-1 truncate", failed ? "text-cf-error" : "text-cf-text")}>{data.label}</span>
          <InlineView value={data.meta} className="shrink-0 tabular-nums" />
        </div>
      )}
      <Progress
        value={value === null ? null : value * 100}
        aria-label={data.label || "Progress"}
        className={cn("h-1 bg-cf-surface-sunken motion-reduce:[&>*]:animate-none", failed ? "[&>*]:bg-cf-error" : "[&>*]:bg-cf-text/60")}
      />
    </div>
  );
}
