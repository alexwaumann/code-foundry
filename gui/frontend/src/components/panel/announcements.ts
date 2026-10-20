/** What screen readers hear while a side panel tab is dragged (dnd-kit's live region). */
import type { Announcements, UniqueIdentifier } from "@dnd-kit/core";
import { allTabs, getPanel, groupAt, groupOf, type GroupIndex } from "@/stores/panel";
import type { DropTarget } from "./dragDrop";

const groupName = (g: GroupIndex) => (g === 0 ? "first" : "second");
const position = (i: number, n: number) => `position ${String(i + 1)} of ${String(n)}`;

/** A tab's 1-based place in its group now, or null when it is not in the panel. */
function placeOf(panelKey: string, id: string): string | null {
  const e = getPanel(panelKey);
  const g = groupOf(e, id);
  if (g === null) return null;
  const tabs = groupAt(e, g).tabs;
  return position(
    tabs.findIndex((t) => t.id === id),
    tabs.length,
  );
}

/** What is said while tab `name` (`id`) is over `t`, read from the panel `panelKey` as it is. */
export function overText(panelKey: string, id: string, name: string, t: DropTarget | null): string {
  if (t === null) return `Tab ${name} is no longer over a place to drop it.`;
  switch (t.kind) {
    case "reorder": {
      const e = getPanel(panelKey);
      const g = groupOf(e, id);
      const tabs = g === null ? [] : groupAt(e, g).tabs;
      return `Tab ${name} is over ${position(
        tabs.findIndex((x) => x.id === t.overId),
        tabs.length,
      )}.`;
    }
    case "strip":
      return `Tab ${name} is over the ${groupName(t.group)} group's tabs, ${position(t.index, groupAt(getPanel(panelKey), t.group).tabs.length + 1)}.`;
    case "body":
      return `Tab ${name} is over the ${groupName(t.group)} group.`;
    case "band":
      return `Tab ${name} is over the edge of the side panel: dropping it there splits the panel.`;
  }
}

/** What is said once tab `name` (`id`) was dropped on `t` (after the move: its place is where it is now). */
export function droppedText(panelKey: string, id: string, name: string, t: DropTarget | null): string {
  const place = placeOf(panelKey, id);
  if (t === null || place === null) return `Tab ${name} was dropped.`;
  switch (t.kind) {
    case "reorder":
      return `Tab ${name} was dropped at ${place}.`;
    case "strip":
    case "body":
      return `Tab ${name} was moved to the ${groupName(t.group)} group, ${place}.`;
    case "band":
      return `Tab ${name} was moved to a new second group.`;
  }
}

/**
 * dnd-kit's announcements, in tab titles, group names and 1-based positions instead of
 * ids. dnd-kit only passes them the tab and what it is over; `track` gives them the
 * target the collisions chose (PanelDnd calls it before dnd-kit announces).
 */
export function tabAnnouncer(panelKey: string): { announcements: Announcements; track: (t: DropTarget | null) => void } {
  let target: DropTarget | null = null;
  const title = (id: UniqueIdentifier) => allTabs(getPanel(panelKey)).find((t) => t.id === id)?.title ?? "tab";
  return {
    track: (t) => {
      target = t;
    },
    announcements: {
      onDragStart: ({ active }) => `Picked up tab ${title(active.id)}.`,
      onDragOver: ({ active }) => overText(panelKey, String(active.id), title(active.id), target),
      onDragEnd: ({ active }) => droppedText(panelKey, String(active.id), title(active.id), target),
      onDragCancel: ({ active }) => `Moving tab ${title(active.id)} was cancelled.`,
    },
  };
}
