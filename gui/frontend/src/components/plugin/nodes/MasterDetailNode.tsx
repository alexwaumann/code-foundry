import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { nodeScope, type Row } from "@/api/plugin";
import { VirtualStack, type Reveal } from "@/components/pr/VirtualStack";
import { VirtualScrollRoot } from "@/components/pr/virtualRoot";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { chooseElement, chooserKeyOf, closeDetail, openDetail, useChoice, useDetailOpen } from "@/stores/pluginSurfaces";
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
 * row with an event its click; the latest row chosen reads as selected from the click
 * until the plugin's next view (stores/pluginSurfaces chooseElement; a view that does not
 * select it goes back to the list), and the detail on screen dims and lets its live nodes
 * go meanwhile (live.ts LeavingNode). The hidden side is not drawn, so it holds no stream.
 *
 * Focus (narrow): choosing a row focuses Back in the commit that shows the detail; when
 * the list comes back (Back, a refused choice, the plugin moving on) with focus lost, the
 * row whose detail it was is scrolled into view and focused in the commit that draws it
 * (VirtualStack reveal). Neither is attempted later than that, nor when focus is elsewhere.
 */
export function MasterDetailNode({ node, data }: NodeProps<"masterDetail">) {
  const ctx = useViewCtx();
  const inner = useInnerList();
  const leaving = useContext(LeavingNode);
  const run = useRunAction();
  const ref = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // Stable: an inline callback ref detaches and re-attaches on every render (two renders a pass).
  const setRef = useCallback((e: HTMLDivElement | null) => {
    ref.current = e;
    setEl(e);
  }, []);
  const [listSide, setListSide] = useState<HTMLDivElement | null>(null);
  const [detailSide, setDetailSide] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(el);
  const listWidth = masterDetailListWidth(data);
  const wide = masterDetailWide(width, listWidth);
  const cap = useNodeHeight(ref, "fill", undefined, FILL_MIN);
  const rows = data.list.rows ?? [];
  const selected = data.selected ?? "";
  // The chooser's key is also the narrow state's (stores/pluginSurfaces details).
  const detailKey = chooserKeyOf(ctx.instance, ctx.viewTab, node.key);
  const choice = useChoice(ctx.watchKey, detailKey);
  // The latest row chosen, while the plugin's view does not select it yet.
  const picking = choice !== undefined && choice !== selected && rows.some((r) => r.key === choice && chooses(r)) ? choice : undefined;
  const shown = picking ?? selected;
  const shownRow = rows.find((r) => r.key === shown);
  const open = useDetailOpen(detailKey);
  const showDetail = wide || (open && shownRow !== undefined);
  const scope = nodeScope(node);
  const inside = useMemo(() => ({ ...ctx, viewTab: ctx.viewTab + scope }), [ctx, scope]);

  // Narrow: Back takes focus in the commit right after a choice (one try).
  const focusBack = useRef(false);
  useLayoutEffect(() => {
    if (!focusBack.current) return;
    focusBack.current = false;
    const back = !wide && el ? el.querySelector<HTMLElement>('[data-testid="plugin-md-back"]') : null;
    if (back && el && focusFree(el)) back.focus();
  });

  // Narrow: the list coming back (Back, a refused choice, the plugin moving on) with focus
  // lost hands it to the row whose detail it was (the list's reveal).
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealRow = useCallback((key: string) => {
    const r: Reveal = {
      key,
      done: (item) => {
        setReveal((cur) => (cur === r ? null : cur));
        const root = ref.current;
        const target = item?.matches('[data-testid="plugin-row"]') ? item : item?.querySelector<HTMLElement>('[data-testid="plugin-row"]');
        if (target && root && focusFree(root)) target.focus();
      },
    };
    setReveal(r);
  }, []);
  const was = useRef({ wide, showDetail, shown });
  useLayoutEffect(() => {
    const before = was.current;
    was.current = { wide, showDetail, shown };
    if (wide || before.wide || !before.showDetail || showDetail || !before.shown || !el) return;
    if (focusFree(el)) revealRow(before.shown);
  }, [wide, showDetail, shown, revealRow, el]);

  const choose = (r: Row) => {
    if (ctx.inert) return;
    if (!chooses(r)) {
      run(r.key, r.action);
      return;
    }
    openDetail(detailKey, data.resetToken ?? "", selected);
    if (!wide) focusBack.current = true;
    if (r.key === shown) return;
    void chooseElement(ctx.watchKey, detailKey, r.key).then((how) => {
      // Refused (and still the latest choice): back to the list; focus follows (above).
      if (how === "refused") closeDetail(detailKey);
    });
  };
  const back = () => {
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
        reveal={reveal ?? undefined}
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
  const detailLabel = shownRow?.title;

  return (
    <div
      ref={setRef}
      className={cn("flex min-w-0 shrink-0", wide ? "flex-row items-stretch gap-3" : cn("flex-col", listGap(inner)))}
      style={wide ? { maxHeight: cap } : undefined}
      role="group"
      data-testid="plugin-master-detail"
      data-key={node.key}
      data-layout={wide ? "wide" : "narrow"}
      data-showing={wide ? "both" : showDetail ? "detail" : "list"}
      data-selected={shown || undefined}
      data-width={width ?? undefined}
    >
      {wide ? (
        <>
          {/* The rows overhang 8 px to the left (like a list's), so the side does too; the right is clipped at the gap.
              No overscroll-contain on either side: at its end a side hands the wheel on to the body (what follows the node stays reachable). */}
          <div key="wide-list" ref={setListSide} className="-ml-2 flex min-h-0 shrink-0 flex-col overflow-x-hidden overflow-y-auto pl-2" style={{ width: listWidth + 8 }} role="region" aria-label="List" data-testid="plugin-md-list">
            <VirtualScrollRoot.Provider value={listSide}>{list}</VirtualScrollRoot.Provider>
          </div>
          <div ref={setDetailSide} className="-mx-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-2" role="region" aria-label={detailLabel ?? "Detail"} data-testid="plugin-md-detail">
            <VirtualScrollRoot.Provider value={detailSide}>{detail}</VirtualScrollRoot.Provider>
          </div>
        </>
      ) : showDetail ? (
        <>
          <Button variant="ghost" size="xs" className="-ml-2 max-w-full min-w-0 self-start text-muted-foreground hover:text-foreground" onClick={back} data-testid="plugin-md-back" aria-label={`Back to the list from ${detailLabel ?? ""}`}>
            <ChevronLeft aria-hidden />
            <span className="truncate">{shownRow?.title}</span>
          </Button>
          <div className="flex min-w-0 flex-col" role="region" aria-label={detailLabel ?? "Detail"} data-testid="plugin-md-detail">
            {detail}
          </div>
        </>
      ) : (
        <div key="narrow-list" className="flex min-w-0 flex-col" role="region" aria-label="List" data-testid="plugin-md-list">
          {list}
        </div>
      )}
    </div>
  );
}

/**
 * Whether focus may move inside `root`: nothing has it (the element that had it went), it
 * is already inside, or a box around root has it (WebKit does not focus a clicked button:
 * the nearest focusable box around it, the side panel, takes focus instead).
 */
function focusFree(root: HTMLElement): boolean {
  const a = document.activeElement;
  return !a || a === document.body || root.contains(a) || a.contains(root);
}
