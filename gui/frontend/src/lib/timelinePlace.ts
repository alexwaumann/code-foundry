/**
 * Where the reader left a conversation's list (components/thread/Timeline.tsx), so the next
 * visit opens there instead of at the bottom (docs/notes/thread-switch-place.md). Only a list
 * scrolled up has a place: one following the bottom opens at the bottom, which by then may
 * hold newer rows. The place is a row and how far it starts from the viewport's top, not a
 * scroll offset: rows fold again on leaving and unmeasured rows are estimates, so an offset
 * would land somewhere else. In memory only; a reload opens every list at the bottom.
 */

/** The row at the top of the viewport (`rows[index]`) and how far it starts below the viewport's top (negative: above it). */
export interface TimelinePlace<R extends { key: string }> {
  index: number;
  offset: number;
  rows: readonly R[];
}

/** How many lists keep a place: the least recently left go first. */
const KEPT_PLACES = 64;
const places = new Map<string, TimelinePlace<{ key: string }>>();

/** Remembers a list's place; `null` (the list follows the bottom) forgets it. */
export function keepTimelinePlace(id: string, place: TimelinePlace<{ key: string }> | null): void {
  places.delete(id);
  if (!place) return;
  places.set(id, place);
  const oldest = places.keys().next();
  if (places.size > KEPT_PLACES && !oldest.done) places.delete(oldest.value);
}

/** The place a list was left at; undefined when it followed the bottom (or was never left). */
export function timelinePlace<R extends { key: string }>(id: string): TimelinePlace<R> | undefined {
  return places.get(id) as TimelinePlace<R> | undefined;
}

/** Forgets every place (tests). */
export function resetTimelinePlaces(): void {
  places.clear();
}

/**
 * The row of `rows` that stands for a place: the place's own row when it is still there
 * (`own`), else the nearest row before it that is, else the nearest after (a row that folded
 * away with its turn is stood in for by the turn's header). Undefined when none is left.
 */
export function placeRow<R extends { key: string }>(place: TimelinePlace<R>, rows: readonly R[]): { at: number; own: boolean } | undefined {
  const index = new Map(rows.map((r, i) => [r.key, i]));
  const key = place.rows[place.index]?.key ?? "";
  let at = index.get(key);
  for (let i = place.index - 1; at === undefined && i >= 0; i--) at = index.get(place.rows[i]?.key ?? "");
  for (let i = place.index + 1; at === undefined && i < place.rows.length; i++) at = index.get(place.rows[i]?.key ?? "");
  return at === undefined ? undefined : { at, own: rows[at]?.key === key };
}

/**
 * The scroll offset that shows a place, given where its row starts. The place's own row keeps
 * its offset; a row standing in for it starts at the viewport's top, not as far above it as
 * the reader had scrolled into the row that went away (an open tool row's output can be
 * hundreds of px).
 */
export function placeTop(place: { offset: number }, start: number, own: boolean): number {
  return start - (own ? place.offset : Math.max(place.offset, 0));
}
