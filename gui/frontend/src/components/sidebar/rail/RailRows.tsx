import { memo, useContext } from "react";
import { Pin } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { NeedsHoverCard } from "@/components/needs/NeedsCard";
import { Tip } from "@/components/ui/tooltip";
import type { DraftRow, ShellRow, ShellThreadRow } from "@/lib/shellSections";
import { statusLine } from "@/lib/statusLine";
import { cn } from "@/lib/utils";
import { useThreadDrag } from "@/shell/drag/draggable";
import { useNeedsStore } from "@/stores/needs";
import { useThreadsStore } from "@/stores/threads";
import { RowTooltipsEnabled } from "../rowTooltips";
import { ThreadTooltip } from "../SidebarRow";
import { railDraftLook, railThreadLook, railTileClass, type RailLook } from "./railLook";

/**
 * A row of the expanded sidebar drawn as one icon on the rail (docs/notes/sidebar-rail.md). It
 * behaves as the row does: the same click (the list's activate), the same hover card (a Needs you
 * row's NeedsHoverCard, a thread's ThreadTooltip), the same context menu (the listbox finds the
 * row by data-row-key), the same drag into the grid and onto a space tab (useThreadDrag), the
 * same keyboard cursor. Renaming (F2, the menu's Rename) opens the expanded list, where the
 * rename field is; a double click does not rename here: the click before it opens the thread and
 * hands the keyboard to its prompt, which would take it from the field the list just mounted.
 */

interface RailRowProps<R> {
  row: R;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: ShellRow) => void;
}

function Glyph({ look }: { look: RailLook }) {
  const Icon = look.icon;
  return <Icon className={cn("size-4 shrink-0", look.tone)} aria-hidden data-testid="rail-row-icon" data-kind={look.kind} />;
}

/** The small pin on a pinned thread's icon, on its top right corner. */
function PinMark({ id }: { id: string }) {
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  if (!pinned) return null;
  return (
    <span className="absolute top-0 -right-px flex rounded-full bg-cf-sidebar p-px text-cf-icon-muted" aria-label="pinned" data-testid="rail-pinned">
      <Pin className="size-2.25" aria-hidden />
    </span>
  );
}

const RailThreadRow = memo(function RailThreadRow({ row, selected, cursor, onActivate }: RailRowProps<ShellThreadRow>) {
  const id = row.threadId;
  const needs = row.section === "needs";
  const cards = useContext(RowTooltipsEnabled);
  const keyCursor = useNeedsStore((s) => s.keyCursor);
  const line = useThreadsStore(useShallow((s) => statusLine(s.byId[id])));
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const { setNodeRef, listeners, describedBy, dragging } = useThreadDrag(id);
  const look = railThreadLook(row.section, line);
  const body = (
    <div
      ref={setNodeRef}
      {...listeners}
      id={`row-${row.key}`}
      role="option"
      aria-selected={selected}
      aria-label={name || id}
      aria-describedby={describedBy}
      data-row-kind="thread"
      data-row-key={row.key}
      data-section={row.section}
      data-cursor={cursor || undefined}
      data-testid="rail-row"
      className={cn(railTileClass(selected, cursor), dragging && "opacity-60")}
      onClick={() => {
        onActivate(row);
      }}
    >
      <Glyph look={look} />
      <PinMark id={id} />
    </div>
  );
  if (!needs) return <ThreadTooltip id={id}>{body}</ThreadTooltip>;
  // The anchor is the expanded row's: the list's Enter opens the popup on it, and only one of the two is ever drawn.
  return (
    <NeedsHoverCard threadId={id} anchor={`sidebar:${id}`} keyboardOpen={cursor && keyCursor} enabled={cards}>
      {body}
    </NeedsHoverCard>
  );
});

/** A draft: its label, which the expanded row shows, is the tooltip; no drag (a draft row has none). */
const RailDraftRow = memo(function RailDraftRow({ row, selected, cursor, onActivate }: RailRowProps<DraftRow>) {
  return (
    <Tip label={row.label || "Untitled draft"} side="right">
      <div
        id={`row-${row.key}`}
        role="option"
        aria-selected={selected}
        aria-label={row.label || "Untitled draft"}
        data-row-kind="draft"
        data-row-key={row.key}
        data-draft-id={row.draftId}
        data-section="active"
        data-cursor={cursor || undefined}
        data-testid="rail-row"
        className={railTileClass(selected, cursor, true)}
        onClick={() => {
          onActivate(row);
        }}
      >
        <Glyph look={railDraftLook()} />
      </div>
    </Tip>
  );
});

/** One row of Needs you or Active as its icon; headers are not drawn on the rail. */
export function RailRowView({ row, selected, cursor, onActivate }: RailRowProps<ShellRow>) {
  if (row.kind === "draft") return <RailDraftRow row={row} selected={selected} cursor={cursor} onActivate={onActivate} />;
  if (row.kind !== "thread" || row.section === "working" || row.section === "snoozed" || row.section === "archived") return null;
  return <RailThreadRow row={row} selected={selected} cursor={cursor} onActivate={onActivate} />;
}
