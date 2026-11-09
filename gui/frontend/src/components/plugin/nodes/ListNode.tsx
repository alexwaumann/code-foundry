import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ListData, Row } from "@/api/plugin";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { cn } from "@/lib/utils";
import { useRunAction } from "../actions";
import { useViewCtx } from "../context";
import { useElementWidth } from "../layout";
import { AddRowInput, RowCheck, RowGrip, TitleEditor } from "../ListRows";
import { useKeyMove, useRowChanges, useRowDrag, type RowOps } from "../listRowsState";
import { foldRowActions, openRowMenuFromKey, rowMenuItems } from "../menu";
import { GlyphView, InlineLine, PillView, PluginButton } from "../parts";
import { MoreMenu, RowContextMenu } from "../PluginMenu";
import type { NodeProps } from "../registry";
import { keysOf } from "../rows";
import { toneText } from "../tones";

/**
 * One list row. A row with an action runs it on click (Enter, Space); `onActivate`
 * replaces that (a master-detail's rows: every row chooses, and the chosen one is the
 * list's current item, aria-current, not a pressed toggle), and `selected` the row's own
 * selected flag (its optimistic choice). `ops` makes it interactive (ListRows.tsx, listRowsState.ts): a
 * checkbox in the glyph's place, a grip and alt+↑/↓ to reorder, a title renamed in place
 * (double-click it or F2; Enter too when the row has no action of its own, which Enter
 * runs otherwise; a row with an action keeps its click, so double-clicking it does not
 * rename). `lifted` draws it as the row being dragged.
 *
 * A row with a menu shows a ⋯ (More options) at its end on hover and focus, and opens the
 * same menu on a right-click (or the ContextMenu key, Shift+F10). A row narrower than its
 * buttons need folds them into that menu, first (sketch C: menu.ts foldRowActions); a dense
 * row folds its labelled buttons (it has no line to show them on). The lifted copy has no menu.
 */
export function RowView({ row, glyphStyle, dense, onActivate, selected: shown, ops, lifted }: { row: Row; glyphStyle: "dot" | "icon"; dense: boolean; onActivate?: () => void; selected?: boolean; ops?: RowOps; lifted?: boolean }) {
  const run = useRunAction();
  const { inert } = useViewCtx();
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Only a row with buttons follows its width (one ResizeObserver each).
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const setRow = useCallback((e: HTMLDivElement | null) => {
    rowRef.current = e;
    setEl(e);
  }, []);
  const width = useElementWidth((row.actions?.length ?? 0) > 0 ? el : null);
  const folded = foldRowActions(width, row.actions, dense);
  const menu = lifted ? undefined : rowMenuItems(row, folded);
  const shownActions = folded ? [] : (row.actions ?? []);
  const iconOnly = shownActions.filter((b) => b.iconOnly);
  const labelled = shownActions.filter((b) => !b.iconOnly);
  const clickable = (onActivate !== undefined || row.action !== undefined) && !inert;
  const editable = ops !== undefined && row.editable === true && !ops.inert && !lifted;
  const reorderable = ops?.reorderable === true && !ops.inert && !lifted;
  const focusable = clickable || editable || reorderable;
  const selected = shown ?? row.selected ?? false;
  const checked = ops?.checkable === true && row.checked === true;
  const activate = () => {
    if (!clickable || editing) return;
    if (onActivate) onActivate();
    else run(row.key, row.action);
  };
  const startEdit = () => {
    if (editable) setEditing(true);
  };
  return (
    <RowContextMenu items={menu}>
      <div
        ref={setRow}
        role={clickable ? "button" : focusable ? "group" : undefined}
        tabIndex={focusable ? 0 : undefined}
        aria-label={!clickable && focusable ? row.title : undefined}
        aria-pressed={clickable && !onActivate ? selected : undefined}
        aria-current={(!clickable || onActivate) && selected ? "true" : undefined}
        aria-keyshortcuts={[editable && "F2", reorderable && "Alt+ArrowUp Alt+ArrowDown"].filter(Boolean).join(" ") || undefined}
        className={cn(
          "group/row -mx-2 flex min-w-0 gap-2 rounded-md px-2 outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
          dense ? "h-6 items-center" : "items-start py-1.5",
          clickable && "cursor-default hover:bg-cf-control-hover dark:hover:bg-cf-control-hover/50",
          selected && "bg-cf-control-hover dark:bg-cf-control-hover/50",
          ops?.dragging === row.key && !lifted && "opacity-35",
        )}
        data-testid={lifted ? "plugin-row-lifted" : "plugin-row"}
        data-key={row.key}
        data-selected={selected || undefined}
        data-checked={checked || undefined}
        data-folded={folded || undefined}
        onClick={activate}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (menu && openRowMenuFromKey(e)) return;
          if (e.target !== e.currentTarget) return;
          if (reorderable && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            e.stopPropagation();
            ops.moveBy(row.key, e.key === "ArrowUp" ? -1 : 1);
            requestAnimationFrame(() => {
              const el = rowRef.current;
              // jsdom has no scrollIntoView.
              if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest" });
            });
          } else if (e.key === "F2" || (e.key === "Enter" && !clickable && editable)) {
            if (!editable) return;
            e.preventDefault();
            startEdit();
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
      >
        {ops?.reorderable && <RowGrip row={row} ops={ops} dense={dense} />}
        {ops?.checkable ? (
          <RowCheck row={row} ops={ops} dense={dense} />
        ) : (
          row.glyph && (
            <span className={cn("flex shrink-0 items-center justify-center", dense ? "size-3.5" : "h-5 w-3.5")}>
              <GlyphView glyph={row.glyph} style={glyphStyle} named={row.pill !== undefined} />
            </span>
          )
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2 text-body-sm">
            {editing ? (
              <TitleEditor
                title={row.title}
                onCommit={(t) => {
                  ops?.edit(row.key, t);
                }}
                done={(refocus) => {
                  setEditing(false);
                  if (refocus) requestAnimationFrame(() => rowRef.current?.focus());
                }}
              />
            ) : (
              // The meta gives way first; a title wider than the row truncates on its own.
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="contents" onDoubleClick={clickable ? undefined : startEdit} data-testid="plugin-row-title">
                  <InlineLine value={row.title} className={cn("max-w-full shrink-0 font-medium", checked && "text-cf-text-muted line-through")} />
                </span>
                <InlineLine value={row.titleMeta} className="font-mono text-caption-sm" />
              </span>
            )}
            <PillView pill={row.pill} />
          </div>
          {!dense && row.line2 !== undefined && <InlineLine value={row.line2} className={cn("text-caption-sm", lineTone(row))} />}
          {!dense && labelled.length > 0 && (
            // Buttons stop the row's own click.
            <div className="mt-1 flex flex-wrap gap-1.5" onClick={(e) => { e.stopPropagation(); }} role="presentation">
              {labelled.map((b) => (
                <PluginButton key={b.key} button={b} />
              ))}
            </div>
          )}
        </div>
        {(row.trailing !== undefined || iconOnly.length > 0 || menu) && (
          <div className={cn("flex shrink-0 items-center gap-1", !dense && "min-h-5")} onClick={(e) => { e.stopPropagation(); }} role="presentation">
            <InlineLine value={row.trailing} className="text-caption-sm tabular-nums" />
            {iconOnly.map((b) => (
              <PluginButton key={b.key} button={b} />
            ))}
            {/* Its place is kept while hidden, so the trailing values of a list's rows line up. */}
            {menu && <MoreMenu items={menu} className={cn("opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100", dense ? "-my-1" : "-my-0.5")} />}
          </div>
        )}
      </div>
    </RowContextMenu>
  );
}

/** Line 2 is muted unless a span carries its own tone (the sidebar's coloured second line). */
function lineTone(row: Row): string {
  const v = row.line2;
  if (typeof v === "object" && v.spans?.some((s) => s.tone)) return "";
  return toneText.muted;
}

/** Whether a list has interactive rows (ListRows.tsx). */
function interactive(data: ListData): boolean {
  return data.checkable === true || data.reorderable === true || data.add !== undefined || (data.rows ?? []).some((r) => r.editable);
}

/** A list of rows (dot or icon glyphs, two lines or dense); over 40 rows it virtualizes against the panel body. */
export function ListNode({ data, node }: NodeProps<"list">) {
  if (interactive(data)) return <InteractiveList data={data} listKey={node.key} />;
  const rows = data.rows ?? [];
  if (rows.length === 0) return <EmptyText data={data} />;
  const glyphStyle = data.glyphStyle ?? "dot";
  const dense = data.dense ?? false;
  return (
    <VirtualStack
      items={rows}
      itemKey={(r) => r.key}
      estimate={dense ? 24 : 44}
      className="flex min-w-0 flex-col"
      testId="plugin-list"
      render={(r) => <RowView row={r} glyphStyle={glyphStyle} dense={dense} />}
    />
  );
}

function EmptyText({ data }: { data: ListData }) {
  return data.emptyText ? (
    <p className="text-caption" data-testid="plugin-list-empty">
      {data.emptyText}
    </p>
  ) : null;
}

const noRows: readonly Row[] = [];

/**
 * A list with interactive rows: the plugin's rows with the user's changes in flight, the
 * add input above (or below) them, and while a row is dragged its lifted copy under the
 * pointer and the drop line.
 */
function InteractiveList({ data, listKey }: { data: ListData; listKey: string }) {
  const { inert } = useViewCtx();
  const { rows, change } = useRowChanges(data.rows ?? noRows);
  const keys = useMemo(() => keysOf(rows), [rows]);
  const box = useRef<HTMLDivElement>(null);
  const onMove = useCallback(
    (key: string, after: string) => {
      change({ kind: "move", key, after });
    },
    [change],
  );
  const { grab, drag } = useRowDrag(keys, box, onMove);
  const moveBy = useKeyMove(rows, change);
  const glyphStyle = data.glyphStyle ?? "dot";
  const dense = data.dense ?? false;
  const ops: RowOps = useMemo(
    () => ({
      checkable: data.checkable === true,
      reorderable: data.reorderable === true,
      inert,
      check: (key, checked) => {
        change({ kind: "check", key, checked });
      },
      edit: (key, title) => {
        change({ kind: "edit", key, title });
      },
      moveBy,
      grab,
      dragging: drag?.key ?? null,
    }),
    [data.checkable, data.reorderable, inert, change, moveBy, grab, drag?.key],
  );
  const lifted = drag ? rows.find((r) => r.key === drag.key) : undefined;
  const add = data.add && <AddRowInput listKey={listKey} add={data.add} />;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="plugin-list-rows">
      {add && !data.add?.bottom && add}
      {rows.length === 0 ? (
        <EmptyText data={data} />
      ) : (
        <div ref={box} className="relative min-w-0" data-dragging={drag ? "" : undefined}>
          <VirtualStack
            items={rows}
            itemKey={(r) => r.key}
            estimate={dense ? 24 : 44}
            className="flex min-w-0 flex-col"
            testId="plugin-list"
            render={(r) => <RowView row={r} glyphStyle={glyphStyle} dense={dense} ops={ops} />}
          />
          {drag?.lineY != null && (
            <div className="pointer-events-none absolute -inset-x-0.5 z-10 h-0.5 -translate-y-1/2 rounded-full bg-cf-focus" style={{ top: drag.lineY }} data-testid="plugin-row-drop" />
          )}
        </div>
      )}
      {add && data.add?.bottom && add}
      {drag &&
        lifted &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 rounded-md border border-cf-border-strong bg-cf-surface-raised px-2 shadow-lg"
            style={{ top: drag.top, left: drag.left, width: drag.width }}
          >
            <RowView row={lifted} glyphStyle={glyphStyle} dense={dense} ops={ops} lifted />
          </div>,
          document.body,
        )}
    </div>
  );
}
