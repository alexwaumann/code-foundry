import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import type { SortDir, TableColumn, TableGroup, TableRow, TableSort } from "@/api/pluginTable";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { DENSE_ROW_H, GroupLabel, RowGrid, SectionTitle, TABLE_BODY, TABLE_BOX, TABLE_ROW, TABLE_ROW_H, TableHead } from "@/components/table/TableParts";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { actOnElement, CHOICE_HOLD_MS, draftKeyOf, setCollapsed, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useRunAction } from "../actions";
import { useViewCtx } from "../context";
import { useElementWidth } from "../layout";
import { openRowMenuFromKey, rowMenuItems } from "../menu";
import { GlyphView, InlineLine, PillView, PluginButton } from "../parts";
import { MoreMenu, RowContextMenu } from "../PluginMenu";
import type { NodeProps } from "../registry";
import { allRows, cellParts, CELL_STYLE, columnWidths, nextSort, tableItems, tableLayout, type TableItem, type TableLayout } from "../table";
import { MeterCell } from "./MeterCell";

/**
 * A plugin table (docs/notes/plugin-table.md), drawn like the Pull Requests page's
 * (components/table): an optional heading with its count, a bordered box, the overline
 * header row and 28 px rows (24 dense). It measures its own width and shows the columns
 * that fit, least important dropped first; its rows' buttons fold into their ⋯ first.
 *
 * A sortable column's header is a button: a click sends a sort act (the column's key, the
 * direction asked for); the plugin answers with its rows in that order and the host draws
 * the arrow, the asked one while the act is out. A group's label collapses it (the user's
 * toggle is kept per instance and view tab, like a section's). Over 40 lines the body is
 * drawn lazily against the panel's scroll (VirtualStack).
 */
export function TableNode({ node, data }: NodeProps<"table">) {
  const ctx = useViewCtx();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const outer = useElementWidth(el);
  // The box's border is not the rows'.
  const layout = tableLayout(data, outer === null ? null : outer - 2);
  const widths = columnWidths(layout, outer === null ? null : outer - 2);
  const sort = useAskedSort(data.sort);
  const groupKeys = (data.groups ?? []).map((g) => draftKeyOf(ctx.instance, ctx.viewTab, g.key));
  const toggled = usePluginSurfacesStore(useShallow((s) => groupKeys.map((k) => s.collapsed[k])));
  const isCollapsed = (g: TableGroup) => toggled[(data.groups ?? []).indexOf(g)] ?? g.collapsed ?? false;
  const items = tableItems(data, isCollapsed);
  const dense = data.dense ?? false;
  const empty = !data.groups && allRows(data).length === 0;
  return (
    <div className="flex min-w-0 flex-col" data-testid="plugin-table" data-key={node.key}>
      {data.title && <SectionTitle count={data.count}>{data.title}</SectionTitle>}
      <div ref={setEl} className={TABLE_BOX} data-testid="plugin-table-box" data-columns={layout.columns.map((c) => c.key).join(",")} data-folded={layout.folded || undefined}>
        <TableHead template={layout.template}>
          {layout.columns.map((c) => (
            <HeaderCell key={c.key} col={c} sort={sort.shown} onSort={(dir) => { sort.ask(c, dir); }} inert={ctx.inert} />
          ))}
          {layout.buttons > 0 && <span aria-hidden />}
          {layout.more && <span aria-hidden />}
        </TableHead>
        <div className={TABLE_BODY}>
          {empty ? (
            data.emptyText ? (
              <p className="px-2 py-1 text-caption" data-testid="plugin-table-empty">
                {data.emptyText}
              </p>
            ) : null
          ) : (
            <VirtualStack
              items={items}
              itemKey={(it) => (it.kind === "group" ? `\u0001group:${it.group.key}` : it.row.key)}
              estimate={dense ? DENSE_ROW_H : TABLE_ROW_H}
              className="flex min-w-0 flex-col"
              testId="plugin-table-rows"
              render={(it) => <Line item={it} layout={layout} widths={widths} dense={dense} groupKey={(g) => groupKeys[(data.groups ?? []).indexOf(g)] ?? ""} />}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The sort the header shows: the one asked for while its act is out and the plugin's view
 * still has the sort it had then, else the view's. A refused act goes back at once; one
 * the plugin takes without answering, after CHOICE_HOLD_MS.
 */
function useAskedSort(sort: TableSort | undefined): { shown: TableSort | undefined; ask: (c: TableColumn, dir: SortDir) => void } {
  const { watchKey, inert } = useViewCtx();
  const [asked, setAsked] = useState<{ sort: TableSort; from: TableSort | undefined; seq: number } | null>(null);
  const seqs = useRef(0);
  const same = (a: TableSort | undefined, b: TableSort | undefined) => a?.column === b?.column && a?.dir === b?.dir;
  const ask = useCallback(
    (c: TableColumn, dir: SortDir) => {
      if (inert) return;
      const seq = ++seqs.current;
      setAsked({ sort: { column: c.key, dir }, from: sort, seq });
      void actOnElement(watchKey, c.key, { action: "sort", value: dir }).then((ok) => {
        const end = () => {
          setAsked((cur) => (cur?.seq === seq ? null : cur));
        };
        if (ok) setTimeout(end, CHOICE_HOLD_MS);
        else end();
      });
    },
    [watchKey, inert, sort],
  );
  return { shown: asked !== null && same(asked.from, sort) ? asked.sort : sort, ask };
}

/** A column's header (its grid cell): its label, or for a sortable column a button with the sorted direction's arrow (on the inner side of the label). */
function HeaderCell({ col, sort, onSort, inert }: { col: TableColumn; sort: TableSort | undefined; onSort: (dir: SortDir) => void; inert: boolean }) {
  const end = col.align === "end";
  const label = col.label ?? "";
  const dir = col.sortable && sort?.column === col.key ? sort.dir : undefined;
  const Arrow = dir === "asc" ? ArrowUp : ArrowDown;
  const arrow = dir && <Arrow className="size-3 shrink-0" aria-hidden />;
  const name = label || col.key;
  return (
    <div className={cn("flex min-w-0", end && "justify-end")} data-col={col.key} data-sort={dir}>
      {col.sortable ? (
        <button
          type="button"
          disabled={inert}
          aria-label={dir ? `${name}, sorted ${dir === "asc" ? "ascending" : "descending"}` : `Sort by ${name}`}
          className={cn(
            // The padding is for the focus ring and hover; the label stays on the column's edge.
            "-mx-1 flex min-w-0 items-center gap-1 rounded-sm px-1 text-overline outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus disabled:pointer-events-none",
            dir && "text-cf-text",
          )}
          onClick={() => {
            onSort(nextSort(col, sort));
          }}
        >
          {end && arrow}
          <Tip label={label} whenTruncated>
            <span className="truncate">{label}</span>
          </Tip>
          {!end && arrow}
        </button>
      ) : (
        <Tip label={label} whenTruncated>
          <span className="min-w-0 truncate">{label}</span>
        </Tip>
      )}
    </div>
  );
}

/** One line of the body: a group's label (a toggle) or a row. */
function Line({ item, layout, widths, dense, groupKey }: { item: TableItem; layout: TableLayout; widths: (number | null)[]; dense: boolean; groupKey: (g: TableGroup) => string }) {
  if (item.kind === "row") return <RowLine row={item.row} layout={layout} widths={widths} dense={dense} />;
  const g = item.group;
  return (
    <div className="h-7" data-key={g.key}>
      <GroupLabel
        name={g.label}
        count={item.count}
        testId="plugin-table-group"
        collapsed={item.collapsed}
        onToggle={() => {
          setCollapsed(groupKey(g), !item.collapsed);
        }}
      />
    </div>
  );
}

/**
 * A row: its shown columns' cells, then its buttons (unless they folded) and its ⋯ (on
 * hover and focus; its place is kept so the columns line up). A row with an action runs it
 * on click, Enter or Space; a right-click (or the ContextMenu key, Shift+F10) opens the
 * same menu as the ⋯.
 */
function RowLine({ row, layout, widths, dense }: { row: TableRow; layout: TableLayout; widths: (number | null)[]; dense: boolean }) {
  const run = useRunAction();
  const { inert } = useViewCtx();
  const menu = rowMenuItems(row, layout.folded);
  const clickable = row.action !== undefined && !inert;
  const selected = row.selected ?? false;
  const activate = () => {
    if (clickable) run(row.key, row.action);
  };
  return (
    <RowContextMenu items={menu}>
      <div
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-pressed={clickable ? selected : undefined}
        aria-current={!clickable && selected ? "true" : undefined}
        className={cn(
          TABLE_ROW,
          "group/row cursor-default outline-none hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus dark:hover:bg-cf-control-hover/50",
          dense ? "h-6" : "h-7",
          selected && "bg-cf-control-hover dark:bg-cf-control-hover/50",
        )}
        data-testid="plugin-table-row"
        data-key={row.key}
        data-selected={selected || undefined}
        onClick={activate}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (menu && openRowMenuFromKey(e)) return;
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            activate();
          }
        }}
      >
        <RowGrid template={layout.template}>
          {layout.columns.map((c, i) => (
            <CellView key={c.key} col={c} row={row} width={widths[i] ?? null} />
          ))}
          {layout.buttons > 0 && (
            // Buttons stop the row's own click.
            <div className="flex min-w-0 items-center justify-end gap-1.5" onClick={(e) => { e.stopPropagation(); }} role="presentation">
              {(row.actions ?? []).map((b) => (
                <PluginButton key={b.key} button={b} />
              ))}
            </div>
          )}
          {layout.more && (
            <div className="flex items-center justify-end" onClick={(e) => { e.stopPropagation(); }} role="presentation">
              {menu && <MoreMenu items={menu} className="opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100" />}
            </div>
          )}
        </RowGrid>
      </div>
    </RowContextMenu>
  );
}

/** A cell: its glyph, its value (one line, its tooltip only when cut) and its pill, in the column's style and alignment; or its meter alone, as wide as the column (`width`). */
function CellView({ col, row, width }: { col: TableColumn; row: TableRow; width: number | null }) {
  const { value, glyph, pill, meter } = cellParts(row.cells?.[col.key]);
  if (meter) {
    return (
      <div className="flex h-full min-w-0 items-center" data-col={col.key}>
        <MeterCell meter={meter} width={width} />
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 tabular-nums", col.align === "end" && "justify-end text-right", CELL_STYLE[col.style ?? ""])} data-col={col.key}>
      {glyph && <GlyphView glyph={glyph} style="icon" named={pill !== undefined} />}
      <InlineLine value={value} />
      {pill && <PillView pill={pill} className="min-w-0 shrink truncate" />}
    </div>
  );
}
