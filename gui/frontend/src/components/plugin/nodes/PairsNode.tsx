import { inlineText } from "@/api/plugin";
import { Tip } from "@/components/ui/tooltip";
import { CopyIconButton, InlineView, PillView } from "../parts";
import type { NodeProps } from "../registry";

/** Facts about one thing: labels muted, values truncating; stacked under 300 px. */
export function PairsNode({ data }: NodeProps<"pairs">) {
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-body-sm @max-[300px]:grid-cols-1 @max-[300px]:gap-y-0" data-testid="plugin-pairs">
      {data.items.map((p) => (
        <div key={p.key} className="contents" data-key={p.key}>
          <dt className="text-muted-foreground whitespace-nowrap @max-[300px]:mt-1">{p.label}</dt>
          <dd className="flex min-h-6 min-w-0 items-center gap-1.5">
            {p.value !== undefined && (
              <Tip label={inlineText(p.value)} whenTruncated>
                <span className="min-w-0 truncate select-text">
                  <InlineView value={p.value} />
                </span>
              </Tip>
            )}
            <PillView pill={p.pill} />
            {p.copyable && p.value !== undefined && <CopyIconButton text={inlineText(p.value)} label={`Copy ${p.label}`} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}
