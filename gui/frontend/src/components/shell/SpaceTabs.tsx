import { useEffect, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pencil, Trash2 } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { afterRev } from "@/shell/commands";
import { useSpaceDropTarget } from "@/shell/drag/state";
import { moveSpace, renameSpace, switchSpace } from "@/shell/spaceActions";
import { reorderIndex } from "@/shell/spaces";
import { useLayoutStore } from "@/stores/layout";
import { openRemoveSpaceDialog } from "@/stores/removeSpaceDialog";
import { useNeedsBySpace } from "@/stores/shellList";
import { SpaceIcon } from "./SpaceIcon";

/** The name field over a tab being renamed: Enter or leaving it renames, Escape keeps the name. */
function NameField({ spaceId, name, onDone }: { spaceId: string; name: string; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) void renameSpace(spaceId, ref.current?.value ?? "");
    onDone();
  };
  return (
    <input
      ref={ref}
      defaultValue={name}
      aria-label="Space name"
      className="w-28 min-w-0 rounded-sm bg-cf-surface px-1 text-body-sm text-cf-text outline-none ring-1 ring-cf-focus"
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => {
        finish(true);
      }}
      data-testid="space-name-field"
    />
  );
}

interface SpaceTabProps {
  spaceId: string;
  current: boolean;
  count: number;
  only: boolean;
  renaming: boolean;
  onRename: (on: boolean) => void;
}

/**
 * One space in the top bar: its layout glyph, its name and, when threads in it need the user, their
 * count. A click shows it; a double click or its menu renames it; its menu removes it (not the last
 * one); it drags to reorder. While a tab or a pane of the grid is dragged over it, it is marked: a
 * drop moves them to this space (ShellDnd).
 */
function SpaceTab({ spaceId, current, count, only, renaming, onRename }: SpaceTabProps) {
  const name = useLayoutStore((s) => s.spaces[spaceId]?.name ?? "");
  const dropping = useSpaceDropTarget(spaceId);
  // dnd-kit's attributes are left out: the tab is a tab (role, tabIndex), and their aria-disabled
  // while renaming would mark the name field inside it disabled too.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: spaceId, disabled: renaming });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...listeners}
          role="tab"
          aria-selected={current}
          tabIndex={current ? 0 : -1}
          style={{ transform: CSS.Translate.toString(transform), transition }}
          className={cn(
            "flex h-7 max-w-48 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-md border px-2 text-body-sm outline-none select-none [--wails-draggable:no-drag] focus-visible:ring-1 focus-visible:ring-cf-focus",
            current ? "border-cf-border bg-cf-surface text-cf-text" : "border-transparent text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
            dropping && "border-cf-focus bg-cf-focus/15 text-cf-text",
            isDragging && "z-10 opacity-70",
          )}
          onClick={() => {
            if (!renaming) void switchSpace(spaceId);
          }}
          onDoubleClick={() => {
            onRename(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void switchSpace(spaceId);
            }
            if (e.key === "F2") onRename(true);
          }}
          data-testid="space-tab"
          data-space-id={spaceId}
          data-current={current || undefined}
          data-drop-target={dropping || undefined}
        >
          <SpaceIcon spaceId={spaceId} />
          {renaming ? (
            <NameField
              spaceId={spaceId}
              name={name}
              onDone={() => {
                onRename(false);
              }}
            />
          ) : (
            <Tip label={name} whenTruncated side="bottom">
              <span className="min-w-0 truncate" data-testid="space-tab-name">
                {name}
              </span>
            </Tip>
          )}
          {count > 0 && (
            <span
              className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-cf-warning-surface px-1 text-caption-sm font-medium text-cf-warning-text tabular-nums"
              aria-label={`${String(count)} ${count === 1 ? "thread needs" : "threads need"} you`}
              data-testid="space-tab-count"
            >
              {count}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="space-tab-menu">
        <ContextMenuItem
          onSelect={() => {
            // After the menu hands the focus back, so the field keeps it.
            setTimeout(() => {
              onRename(true);
            }, 0);
          }}
          data-testid="space-tab-rename"
        >
          <Pencil />
          Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={only}
          onSelect={() => {
            openRemoveSpaceDialog(spaceId);
          }}
          data-testid="space-tab-remove"
        >
          <Trash2 />
          {only ? "The last space stays" : "Remove space…"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The space tabs of the top bar, in their order: a quiet row, the current one a bordered pill.
 * Dragging one to another place moves it there (space.move); the new order shows until the
 * daemon's commit arrives, so the tab does not jump back.
 */
export function SpaceTabs({ renaming, onRenaming }: { renaming: string; onRenaming: (id: string) => void }) {
  const stored = useLayoutStore((s) => s.spaceOrder);
  const current = useLayoutStore((s) => s.currentSpaceId);
  const counts = useNeedsBySpace();
  const [moved, setMoved] = useState<readonly string[] | null>(null);
  const order = moved ?? stored;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id);
    const index = over ? reorderIndex(order, id, String(over.id)) : null;
    if (index === null) return;
    const next = order.filter((x) => x !== id);
    next.splice(index - 1, 0, id);
    setMoved(next);
    void moveSpace(id, index)
      .then((res) => (res ? afterRev(res.rev) : undefined))
      .finally(() => {
        setMoved(null);
      });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
      <SortableContext items={[...order]} strategy={horizontalListSortingStrategy}>
        <div role="tablist" aria-label="Spaces" className="ml-3 flex min-w-0 items-center gap-1 overflow-hidden" data-testid="space-tabs">
          {order.map((id) => (
            <SpaceTab
              key={id}
              spaceId={id}
              current={id === current}
              count={counts[id] ?? 0}
              only={order.length < 2}
              renaming={renaming === id}
              onRename={(on) => {
                onRenaming(on ? id : "");
              }}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
