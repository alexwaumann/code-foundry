import { Separator } from "@/components/ui/separator";
import type { NodeProps } from "../registry";
import { useInStrip } from "../strip";

/**
 * A hairline across the list (docs/notes/plugins-layout-2-grid-inline.md), or with a label
 * a hairline either side of it, centred, in the overline role (one line, cut when longer
 * than the width). In a toolbar or footer (strip.ts) a vertical hairline between its
 * neighbours in the row (the daemon refuses a label there).
 */
export function DividerNode({ node, data }: NodeProps<"divider">) {
  const strip = useInStrip() !== null;
  const label = data.label?.trim() ?? "";
  if (strip) return <Separator orientation="vertical" className="data-[orientation=vertical]:h-5" data-testid="plugin-divider" data-key={node.key} />;
  if (!label) return <Separator className="my-px" data-testid="plugin-divider" data-key={node.key} />;
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="plugin-divider" data-key={node.key} data-label={label}>
      <Separator className="min-w-4 flex-1" />
      <span className="min-w-0 truncate text-overline" data-testid="plugin-divider-label">
        {label}
      </span>
      <Separator className="min-w-4 flex-1" />
    </div>
  );
}
