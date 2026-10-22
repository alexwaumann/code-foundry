import type { KeyboardEvent } from "react";
import type { Row } from "@/api/plugin";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { cn } from "@/lib/utils";
import { useRunAction } from "../actions";
import { useViewCtx } from "../context";
import { GlyphView, InlineLine, PillView, PluginButton } from "../parts";
import type { NodeProps } from "../registry";
import { toneText } from "../tones";

/**
 * One list row. A row with an action runs it on click (Enter, Space); `onActivate`
 * replaces that (a master-detail's rows: every row chooses, and the chosen one is the
 * list's current item, aria-current, not a pressed toggle), and `selected` the row's own
 * selected flag (its optimistic choice).
 */
export function RowView({ row, glyphStyle, dense, onActivate, selected: shown }: { row: Row; glyphStyle: "dot" | "icon"; dense: boolean; onActivate?: () => void; selected?: boolean }) {
  const run = useRunAction();
  const { inert } = useViewCtx();
  const iconOnly = (row.actions ?? []).filter((b) => b.iconOnly);
  const labelled = (row.actions ?? []).filter((b) => !b.iconOnly);
  const clickable = (onActivate !== undefined || row.action !== undefined) && !inert;
  const selected = shown ?? row.selected ?? false;
  const activate = () => {
    if (!clickable) return;
    if (onActivate) onActivate();
    else run(row.key, row.action);
  };
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable && !onActivate ? selected : undefined}
      aria-current={(!clickable || onActivate) && selected ? "true" : undefined}
      className={cn(
        "-mx-2 flex min-w-0 gap-2 rounded-md px-2 outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
        dense ? "h-6 items-center" : "items-start py-1.5",
        clickable && "cursor-default hover:bg-cf-control-hover dark:hover:bg-cf-control-hover/50",
        selected && "bg-cf-control-hover dark:bg-cf-control-hover/50",
      )}
      data-testid="plugin-row"
      data-key={row.key}
      data-selected={selected || undefined}
      onClick={activate}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          activate();
        }
      }}
    >
      {row.glyph && (
        <span className={cn("flex shrink-0 items-center justify-center", dense ? "size-3.5" : "h-5 w-3.5")}>
          <GlyphView glyph={row.glyph} style={glyphStyle} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2 text-body-sm">
          {/* The meta gives way first; a title wider than the row truncates on its own. */}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <InlineLine value={row.title} className="max-w-full shrink-0 font-medium" />
            <InlineLine value={row.titleMeta} className="font-mono text-caption-sm" />
          </span>
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
      {(row.trailing !== undefined || iconOnly.length > 0) && (
        <div className={cn("flex shrink-0 items-center gap-1", !dense && "min-h-5")} onClick={(e) => { e.stopPropagation(); }} role="presentation">
          <InlineLine value={row.trailing} className="text-caption-sm tabular-nums" />
          {iconOnly.map((b) => (
            <PluginButton key={b.key} button={b} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Line 2 is muted unless a span carries its own tone (the sidebar's coloured second line). */
function lineTone(row: Row): string {
  const v = row.line2;
  if (typeof v === "object" && v.spans?.some((s) => s.tone)) return "";
  return toneText.muted;
}

/** A list of rows (dot or icon glyphs, two lines or dense); over 40 rows it virtualizes against the panel body. */
export function ListNode({ data }: NodeProps<"list">) {
  const rows = data.rows ?? [];
  if (rows.length === 0) {
    return data.emptyText ? (
      <p className="text-caption" data-testid="plugin-list-empty">
        {data.emptyText}
      </p>
    ) : null;
  }
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
