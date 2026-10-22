import { inlineText } from "@/api/plugin";
import { Tip } from "@/components/ui/tooltip";
import { CopyIconButton, InlineView, PillView } from "../parts";
import type { NodeProps } from "../registry";

/**
 * Facts about one thing: labels muted, values truncating; stacked under 300 px. The label
 * column takes what its labels need up to 40% of the width; a longer label wraps there
 * rather than squeezing the values.
 */
export function PairsNode({ data }: NodeProps<"pairs">) {
  return (
    <dl className="grid min-w-0 grid-cols-[fit-content(40%)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-body-sm @max-[300px]:grid-cols-1 @max-[300px]:gap-y-0" data-testid="plugin-pairs">
      {data.items.map((p) => (
        <div key={p.key} className="contents" data-key={p.key}>
          <dt className="min-w-0 py-0.5 break-words text-cf-text-muted @max-[300px]:mt-1 @max-[300px]:py-0">{p.label}</dt>
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
