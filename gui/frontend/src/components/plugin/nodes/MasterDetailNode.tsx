import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { nodeScope, type Row } from "@/api/plugin";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actOnElement, closeDetail, draftKeyOf, openDetail, useDetailOpen, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useRunAction } from "../actions";
import { useViewCtx, ViewContext } from "../context";
import { FILL_MIN, useNodeHeight } from "../height";
import { masterDetailListWidth, masterDetailWide, useElementWidth } from "../layout";
import { listGap, useInnerList } from "../list";
import { LeavingNode } from "../live";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";
import { EmptyNode } from "./EmptyNode";
import { RowView } from "./ListNode";

/** Whether choosing the row is a selection (no action: a select act; an event: its click), not a host action (command, URL, copy). */
function chooses(r: Row): boolean {
  return r.action === undefined || Boolean(r.action.event);
}

/**
 * A list beside the detail of its chosen row (docs/notes/plugins-layout-4-master-detail.md).
 * Wide (its own width at least listWidth + 12 + 320 px: layout.ts masterDetailWide), the
 * list at listWidth on the left and the detail filling the rest, each scrolling on its
 * own, the node as tall as the taller side and never taller than the rest of its box
 * (height.ts: the nearest sized pane, else the surface's scroll area) below its top.
 * Narrow (the side panel), the list alone; choosing a row shows the detail alone under a
 * back button with the row's title. Whether it shows the detail is the surface store's
 * (per instance, view tab and node: openDetail, reconcileDetails), so it survives
 * re-renders and remounts and goes back to the list when the plugin's selected row stops
 * being a row or its resetToken changes. A row without an action sends a `select` act, a
 * row with an event its click; the chosen row reads as selected while the act is pending,
 * and the detail on screen dims and lets its live nodes go (live.ts LeavingNode). The
 * hidden side is not drawn, so it holds no stream.
 */
export function MasterDetailNode({ node, data }: NodeProps<"masterDetail">) {
  const ctx = useViewCtx();
  const inner = useInnerList();
  const leaving = useContext(LeavingNode);
  const run = useRunAction();
  const ref = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(el);
  const listWidth = masterDetailListWidth(data);
  const wide = masterDetailWide(width, listWidth);
  const cap = useNodeHeight(ref, "fill", undefined, FILL_MIN);
  const rows = data.list.rows ?? [];
  const selected = data.selected ?? "";
  // The row whose choice is in flight (its act pending), shown as selected meanwhile.
  const picking = usePluginSurfacesStore((s) => rows.find((r) => r.key !== selected && chooses(r) && s.pending[ctx.watchKey]?.[r.key])?.key);
  const shown = picking ?? selected;
  const shownRow = rows.find((r) => r.key === shown);
  const detailKey = draftKeyOf(ctx.instance, ctx.viewTab, node.key);
  const open = useDetailOpen(detailKey);
  const showDetail = wide || (open && shownRow !== undefined);
  const scope = nodeScope(node);
  const inside = useMemo(() => ({ ...ctx, viewTab: ctx.viewTab + scope }), [ctx, scope]);
  const focus = useRef<"back" | "row" | null>(null);

  // Narrow: the back button takes focus when the detail opens, the chosen row when the list returns.
  useEffect(() => {
    const want = focus.current;
    if (!want || !el || wide) return;
    const target =
      want === "back" && showDetail
        ? el.querySelector<HTMLElement>('[data-testid="plugin-md-back"]')
        : want === "row" && !showDetail
          ? el.querySelector<HTMLElement>(`[data-testid="plugin-row"][data-key="${CSS.escape(shown)}"]`)
          : null;
    if (target) {
      target.focus();
      focus.current = null;
    }
  });

  const choose = (r: Row) => {
    if (ctx.inert) return;
    if (!chooses(r)) {
      run(r.key, r.action);
      return;
    }
    openDetail(detailKey, data.resetToken ?? "", selected);
    if (!wide) focus.current = "back";
    if (r.key === shown) return;
    void actOnElement(ctx.watchKey, r.key).then((took) => {
      if (!took) closeDetail(detailKey);
    });
  };
  const back = () => {
    focus.current = "row";
    closeDetail(detailKey);
  };

  const glyphStyle = data.list.glyphStyle ?? "dot";
  const dense = data.list.dense ?? false;
  const list =
    rows.length === 0 ? (
      data.list.emptyText ? (
        <p className="text-caption" data-testid="plugin-list-empty">
          {data.list.emptyText}
        </p>
      ) : null
    ) : (
      <VirtualStack
        items={rows}
        itemKey={(r) => r.key}
        estimate={dense ? 24 : 44}
        className="flex min-w-0 flex-col"
        testId="plugin-list"
        render={(r) => <RowView row={r} glyphStyle={glyphStyle} dense={dense} selected={r.key === shown} onActivate={() => { choose(r); }} />}
      />
    );
  const pending = picking !== undefined;
  const detail =
    shown === "" ? (
      data.emptyDetail ? <EmptyNode node={{ key: `${node.key}-empty` }} data={data.emptyDetail} /> : null
    ) : (
      <ViewContext.Provider value={inside}>
        <LeavingNode.Provider value={leaving || pending}>
          <div className={cn("flex min-w-0 flex-col transition-opacity", pending && "opacity-60")} aria-busy={pending || undefined} data-testid="plugin-md-content" data-pending={pending || undefined}>
            <NodeList nodes={data.detail} inner={inner} />
          </div>
        </LeavingNode.Provider>
      </ViewContext.Provider>
    );

  return (
    <div
      ref={(e) => {
        ref.current = e;
        setEl(e);
      }}
      className={cn("flex min-w-0 shrink-0", wide ? "flex-row items-stretch gap-3" : cn("flex-col", listGap(inner)))}
      style={wide ? { maxHeight: cap } : undefined}
      data-testid="plugin-master-detail"
      data-key={node.key}
      data-layout={wide ? "wide" : "narrow"}
      data-showing={wide ? "both" : showDetail ? "detail" : "list"}
      data-selected={shown || undefined}
      data-width={width ?? undefined}
    >
      {wide ? (
        <>
          {/* The rows overhang 8 px to the left (like a list's), so the side does too; the right is clipped at the gap. */}
          <div key="wide-list" className="-ml-2 flex min-h-0 shrink-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pl-2" style={{ width: listWidth + 8 }} data-testid="plugin-md-list" data-virtual-root>
            {list}
          </div>
          <div className="-mx-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain px-2" data-testid="plugin-md-detail">
            {detail}
          </div>
        </>
      ) : showDetail ? (
        <>
          <Button variant="ghost" size="xs" className="-ml-2 max-w-full min-w-0 self-start text-muted-foreground hover:text-foreground" onClick={back} data-testid="plugin-md-back" aria-label={`Back to the list from ${shownRow?.title ?? ""}`}>
            <ChevronLeft aria-hidden />
            <span className="truncate">{shownRow?.title}</span>
          </Button>
          <div className="flex min-w-0 flex-col" data-testid="plugin-md-detail">
            {detail}
          </div>
        </>
      ) : (
        <div key="narrow-list" className="flex min-w-0 flex-col" data-testid="plugin-md-list">
          {list}
        </div>
      )}
    </div>
  );
}
