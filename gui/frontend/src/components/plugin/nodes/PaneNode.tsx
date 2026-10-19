import { useCallback, useContext, useMemo, useRef, useState } from "react";
import { VirtualScrollRoot } from "@/components/pr/virtualRoot";
import { cn } from "@/lib/utils";
import { FILL_MIN, FillBoxContext, useNodeHeight } from "../height";
import { useInnerList } from "../list";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";

/**
 * A box of nodes with its own height and scroll (docs/notes/plugins-layout-1-columns-pane.md):
 * "auto" (absent) as tall as its nodes, at least minHeight; pixels as given; "fill" the rest
 * of its own box (components/plugin/height.ts), at least minHeight or FILL_MIN. A px or
 * fill pane is the box its fill nodes fill (data-fill-box, height.ts FILL_BOX_ATTR). Taller nodes scroll inside it, or are cut with
 * noScroll. It draws nothing of its own and lays its nodes out like the list around it;
 * a sized pane's list is its box's own (list.ts BoxList: a flex spacer reaches its bottom).
 * A sized pane is the box its fill nodes fill (FillBoxContext) and, scrolling, the box its
 * long lists virtualize against (VirtualScrollRoot); either way the providers are always
 * there (passing the outer value through while auto), so a change of height mode under the
 * same key re-measures the nodes inside without remounting them.
 */
export function PaneNode({ node, data }: NodeProps<"pane">) {
  const inner = useInnerList();
  const ref = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const setRef = useCallback((e: HTMLDivElement | null) => {
    ref.current = e;
    setEl(e);
  }, []);
  const outerBox = useContext(FillBoxContext);
  const outerScroll = useContext(VirtualScrollRoot);
  const floor = data.minHeight !== undefined && data.minHeight > 0 ? data.minHeight : FILL_MIN;
  const height = useNodeHeight(ref, data.height, undefined, floor);
  const mode = data.height === "fill" ? "fill" : typeof data.height === "number" ? "px" : "auto";
  const sized = mode !== "auto";
  const scroll = !(data.noScroll ?? false);
  const ownBox = useMemo(() => ({ box: el, bottom: 0 }), [el]);
  // A log alone in a sized pane shrinks to it (LogNode), so its tail stays in view instead of the pane scrolling past it.
  const fitsLog = sized && data.children.length === 1 && data.children[0]?.log !== undefined;
  return (
    <div
      ref={setRef}
      className={cn("flex min-w-0 shrink-0 flex-col", sized && (scroll ? "overflow-x-hidden overflow-y-auto overscroll-contain" : "overflow-hidden"))}
      style={{ height, minHeight: mode === "auto" ? data.minHeight : undefined }}
      data-testid="plugin-pane"
      data-key={node.key}
      data-height={mode}
      data-scroll={sized ? scroll : undefined}
      data-fill-box={sized || undefined}
    >
      <FillBoxContext.Provider value={sized ? ownBox : outerBox}>
        <VirtualScrollRoot.Provider value={sized && scroll ? el : outerScroll}>
          <NodeList nodes={data.children} inner={inner} box={sized} className={fitsLog ? "min-h-0" : undefined} />
        </VirtualScrollRoot.Provider>
      </FillBoxContext.Provider>
    </div>
  );
}
