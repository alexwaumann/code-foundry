import { Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { SpaceIcon } from "@/components/shell/SpaceIcon";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { bulkMenuItems, bulkSpaceChoices } from "@/lib/bulkMenu";
import { archiveThreads, markThreadsUnread, moveThreadsToNewSpace, moveThreadsToSpace, removeThreads, snoozeThreads } from "@/stores/bulkThreadActions";
import { spaceOfThread, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

const SEP = "\u0000";

/** Move to space ▸ for the selection: the spaces (one where every selected thread lives marked "here"), then New space. */
function BulkSpaceItems({ ids }: { ids: readonly string[] }) {
  const spaces = useLayoutStore(
    useShallow((s) =>
      bulkSpaceChoices(
        s.spaceOrder.map((id) => ({ id, name: s.spaces[id]?.name ?? id })),
        ids.map((t) => spaceOfThread(s, t)),
      ).map((c) => [c.id, c.name, c.here ? "1" : ""].join(SEP)),
    ),
  );
  return (
    <>
      {spaces.map((k) => {
        const [id = "", name = "", here = ""] = k.split(SEP);
        return (
          <ContextMenuItem
            key={id}
            disabled={here !== ""}
            data-testid="move-to-space-item"
            data-space-id={id}
            onSelect={() => {
              // Only the threads not there already move (the daemon refuses a move to a thread's own space).
              const s = useLayoutStore.getState();
              void moveThreadsToSpace(
                ids.filter((t) => spaceOfThread(s, t) !== id),
                id,
              );
            }}
          >
            <SpaceIcon spaceId={id} />
            <span className="truncate">{name}</span>
            {here && <span className="ml-auto pl-4 text-caption text-cf-text-muted">here</span>}
          </ContextMenuItem>
        );
      })}
      <ContextMenuSeparator />
      <ContextMenuItem
        data-testid="move-to-new-space"
        onSelect={() => {
          void moveThreadsToNewSpace(ids);
        }}
      >
        <Plus />
        New space
      </ContextMenuItem>
    </>
  );
}

/**
 * The context menu of a selected row while two or more are selected (docs/notes/sidebar-bulk-select.md):
 * "N threads", then only what applies to every one of them (lib/bulkMenu.ts): Snooze ▸ (the single
 * menu's presets, Pick a date and time…, Save for later), Unsnooze, Mark as unread, Move to space ▸, Archive or
 * Unarchive, Remove. Each is one command given the ids (stores/bulkThreadActions.ts), which asks
 * once for all of them where the single one asks, and drops the selection once it ran.
 */
export function BulkRowMenu({ ids }: { ids: readonly string[] }) {
  const facts = useThreadsStore(useShallow((s) => ids.flatMap((id) => (s.byId[id] ? [s.byId[id]] : []))));
  const items = bulkMenuItems(facts);
  return (
    <ContextMenuContent data-testid="bulk-menu" data-count={ids.length}>
      <ContextMenuLabel className="text-caption text-cf-text-muted" data-testid="bulk-menu-count">
        {ids.length} threads
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {items.snooze && (
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="bulk-menu-snooze">Snooze</ContextMenuSubTrigger>
          <ContextMenuSubContent data-testid="menu-snooze-presets">
            <SnoozePresetItems id={ids[0] ?? ""} ids={ids} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {items.unsnooze && (
        <ContextMenuItem
          data-testid="bulk-menu-unsnooze"
          onSelect={() => {
            void snoozeThreads(ids, null);
          }}
        >
          Unsnooze
        </ContextMenuItem>
      )}
      {items.unread && (
        <ContextMenuItem
          data-testid="bulk-menu-unread"
          onSelect={() => {
            void markThreadsUnread(ids);
          }}
        >
          Mark as unread
        </ContextMenuItem>
      )}
      {items.move && (
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="bulk-menu-move-to-space">Move to space</ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-44" data-testid="bulk-menu-spaces">
            <BulkSpaceItems ids={ids} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {items.archive && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid="bulk-menu-archive"
            onSelect={() => {
              void archiveThreads(ids, items.archive === "archive");
            }}
          >
            {items.archive === "archive" ? "Archive" : "Unarchive"}
          </ContextMenuItem>
        </>
      )}
      {items.remove && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            data-testid="bulk-menu-remove"
            onSelect={() => {
              void removeThreads(ids);
            }}
          >
            Remove
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
