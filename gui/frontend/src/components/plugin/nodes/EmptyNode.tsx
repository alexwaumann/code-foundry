import { GlyphView, ButtonBar, InlineView } from "../parts";
import type { NodeProps } from "../registry";

/** Nothing here yet, with one call to action: centred, narrow. */
export function EmptyNode({ data }: NodeProps<"empty">) {
  return (
    <div className="mx-auto flex w-full max-w-64 flex-col items-center gap-1.5 py-4 text-center" data-testid="plugin-empty">
      {data.glyph && <GlyphView glyph={data.glyph} style="icon" className="mb-1 size-5" />}
      {data.title && <p className="text-subheading">{data.title}</p>}
      {data.body !== undefined && (
        <p className="text-caption">
          <InlineView value={data.body} />
        </p>
      )}
      <ButtonBar buttons={data.actions} className="mt-1.5 justify-center" />
    </div>
  );
}
