import { inlineText } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { CopyIconButton, InlineView } from "../parts";
import type { NodeProps } from "../registry";

/** A sentence, or a value to copy: `sm` muted, `lg` a large mono code that never wraps. */
export function TextNode({ data }: NodeProps<"text">) {
  const size = data.size ?? "";
  return (
    <div className="flex min-w-0 items-start gap-1.5" data-testid="plugin-text" data-size={size || undefined}>
      <p
        className={cn(
          "min-w-0 flex-1 select-text",
          size === "sm" ? "text-caption-sm" : size === "lg" ? "overflow-x-auto font-mono text-title font-medium tracking-widest whitespace-nowrap [scrollbar-width:none]" : "text-body-sm break-words",
        )}
      >
        <InlineView value={data.content} />
      </p>
      {data.copyable && <CopyIconButton text={inlineText(data.content)} />}
    </div>
  );
}
