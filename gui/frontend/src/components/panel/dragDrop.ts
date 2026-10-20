/**
 * Where a dragged side panel tab can land (docs/notes/panel-split-3-drag.md). One
 * DndContext spans both groups (PanelDnd); its droppables are:
 *
 * - each tab (sortable, data `{ kind: "tab", group }`),
 * - each group's header (`headerDropId`), its strip and "+" with the room around them,
 * - each group's body while the panel is split (`bodyDropId`),
 * - the drop band over an unsplit panel's far edge while a tab is dragged (`BAND_DROP_ID`).
 *
 * `panelCollision` turns the pointer into one target: a reorder in the tab's own strip,
 * a slot in the other group's strip, the other group's body (appended last), or the
 * band (a new second group). Anywhere else (its own body outside the band, the divider,
 * outside the panel) is no target, and the drop puts the tab back.
 */
import { closestCenter, type ClientRect, type Collision, type CollisionDetection, type DroppableContainer, type Modifier } from "@dnd-kit/core";
import type { GroupIndex } from "@/stores/panel";

/** The drop band's droppable id. Droppable ids have a space, which tab ids (kind + encoded params) never do. */
export const BAND_DROP_ID = "panel drop: band";

/** A group header's droppable id. */
export function headerDropId(group: GroupIndex): string {
  return `panel drop: header ${String(group)}`;
}

/** A split group's body droppable id. */
export function bodyDropId(group: GroupIndex): string {
  return `panel drop: body ${String(group)}`;
}

/** What a droppable (or the dragged tab) is: its `data`. */
export type DropData = { kind: "tab"; group: GroupIndex } | { kind: "header"; group: GroupIndex } | { kind: "body"; group: GroupIndex } | { kind: "band" };

/** Where a drop would put the dragged tab. */
export type DropTarget =
  /** Its own strip, at the index of the tab `overId` (arrayMove). */
  | { kind: "reorder"; overId: string }
  /** The other group's strip, inserted at `index`. */
  | { kind: "strip"; group: GroupIndex; index: number }
  /** The other group's body: appended last. */
  | { kind: "body"; group: GroupIndex }
  /** The unsplit panel's drop band: a new second group. */
  | { kind: "band" };

/** A droppable's or draggable's DropData, if it has one. */
export function dropDataOf(data: unknown): DropData | null {
  if (typeof data !== "object" || data === null || !("kind" in data)) return null;
  const d = data as { kind: unknown; group?: unknown };
  if (d.kind === "band") return { kind: "band" };
  if ((d.kind === "tab" || d.kind === "header" || d.kind === "body") && (d.group === 0 || d.group === 1)) return { kind: d.kind, group: d.group };
  return null;
}

function contains(r: ClientRect | undefined, x: number, y: number): boolean {
  return r !== undefined && r.width > 0 && r.height > 0 && x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
}

/** Where a tab dropped at `x` goes among tabs whose horizontal centres are `centers` (any order): before every tab right of it. */
export function insertionIndex(centers: readonly number[], x: number): number {
  return centers.filter((c) => c < x).length;
}

function target(id: Collision["id"], t: DropTarget): Collision[] {
  return [{ id, data: { target: t } }];
}

/**
 * The collision detection for the panel's one DndContext. The dragged tab's group comes
 * from its data. In order: the band; its own header (closestCenter among its own tabs,
 * by the lifted tab's rect, as the in-strip reorder always worked); the other header (a
 * slot by the pointer's x among that strip's tabs; the collision is that strip's nearest
 * tab, so dnd-kit auto-scrolls that strip, or the header when it has no tabs); the other
 * body. Nothing else is a target.
 */
export const panelCollision: CollisionDetection = (args) => {
  const { active, droppableContainers, droppableRects, pointerCoordinates: p } = args;
  const dragged = dropDataOf(active.data.current);
  if (!p || dragged?.kind !== "tab") return [];
  const own = dragged.group;
  const other: GroupIndex = own === 0 ? 1 : 0;
  const tagged = droppableContainers.map((c) => ({ c, d: dropDataOf(c.data.current) }));
  const find = (pred: (d: DropData) => boolean): DroppableContainer | undefined => tagged.find(({ d }) => d !== null && pred(d))?.c;
  const tabsOf = (g: GroupIndex) => tagged.filter(({ d }) => d?.kind === "tab" && d.group === g).map(({ c }) => c);
  const rectOf = (c: DroppableContainer | undefined) => (c ? droppableRects.get(c.id) : undefined);

  const band = find((d) => d.kind === "band");
  if (band && contains(rectOf(band), p.x, p.y)) return target(band.id, { kind: "band" });

  if (contains(rectOf(find((d) => d.kind === "header" && d.group === own)), p.x, p.y)) {
    const [first] = closestCenter({ ...args, droppableContainers: tabsOf(own) });
    return first ? target(first.id, { kind: "reorder", overId: String(first.id) }) : [];
  }

  const otherHeader = find((d) => d.kind === "header" && d.group === other);
  if (otherHeader && contains(rectOf(otherHeader), p.x, p.y)) {
    const placed = tabsOf(other).flatMap((c) => {
      const r = droppableRects.get(c.id);
      return r ? [{ id: c.id, center: r.left + r.width / 2 }] : [];
    });
    const index = insertionIndex(
      placed.map((t) => t.center),
      p.x,
    );
    const nearest = placed.reduce<{ id: Collision["id"]; center: number } | null>((best, t) => (best === null || Math.abs(t.center - p.x) < Math.abs(best.center - p.x) ? t : best), null);
    return target(nearest?.id ?? otherHeader.id, { kind: "strip", group: other, index });
  }

  const body = find((d) => d.kind === "body" && d.group === other);
  if (body && contains(rectOf(body), p.x, p.y)) return target(body.id, { kind: "body", group: other });
  return [];
};

/** The target panelCollision chose, from a drag event's collisions. */
export function dropTargetOf(collisions: readonly Collision[] | null | undefined): DropTarget | null {
  const t: unknown = collisions?.[0]?.data?.target;
  return typeof t === "object" && t !== null && "kind" in t ? (t as DropTarget) : null;
}

/** What a drop does to the store: a move in the tab's own group, or to a group (at `index`, or last). */
export type DropMove = { kind: "reorder"; to: number } | { kind: "group"; group: GroupIndex; index?: number };

/**
 * The store change for a drop of `id` (from a strip whose tabs are `ownIds`) on `t`:
 * movePanelTab for a reorder (none onto itself or an unknown tab), movePanelTabToGroup
 * for the rest. The band is group 1 of an unsplit panel, which splits it.
 */
export function dropMove(t: DropTarget | null, id: string, ownIds: readonly string[]): DropMove | null {
  if (t === null) return null;
  switch (t.kind) {
    case "reorder": {
      const to = ownIds.indexOf(t.overId);
      return t.overId === id || to < 0 ? null : { kind: "reorder", to };
    }
    case "strip":
      return { kind: "group", group: t.group, index: t.index };
    case "body":
      return { kind: "group", group: t.group };
    case "band":
      return { kind: "group", group: 1 };
  }
}

/** Whether two targets are the same (the drag only re-renders the panel when its target changes). */
export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "reorder":
      return a.overId === (b as typeof a).overId;
    case "strip":
      return a.group === (b as typeof a).group && a.index === (b as typeof a).index;
    case "body":
      return a.group === (b as typeof a).group;
    case "band":
      return true;
  }
}

/** A box in viewport coordinates. */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A translation for a node at `rect` clamped so the node stays inside `bounds` (where it
 * is too big, its top-left edge wins). Unchanged without a rect or bounds (or empty bounds:
 * an element not laid out).
 */
export function clampTranslate<T extends { x: number; y: number }>(t: T, rect: ClientRect | null, bounds: Bounds | null): T {
  if (!rect || !bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return t;
  const x = Math.max(bounds.left - rect.left, Math.min(bounds.right - (rect.left + rect.width), t.x));
  const y = Math.max(bounds.top - rect.top, Math.min(bounds.bottom - (rect.top + rect.height), t.y));
  return { ...t, x, y };
}

/** A modifier that keeps the lifted tab inside the box `bounds()` returns (the panel, read at each move). */
export function restrictTo(bounds: () => Bounds | null): Modifier {
  return ({ transform, draggingNodeRect }) => clampTranslate(transform, draggingNodeRect, bounds());
}
