/**
 * Where the reader left a page's own document, per place it was shown (a File tab, a thread's
 * card) and file, for its frame to hand back when that place loads the page again: a tab
 * shown again after another tab or space, a card scrolled back into the timeline, an edit or a
 * theme reload (docs/notes/pages-tab-polish.md). The page's document reports it (frame.js
 * `cf:scroll`) and puts it back itself (the frame's ping after a load). In memory only: an app
 * restart starts every page at its top. At most MAX_PLACES, the least recently scrolled
 * forgotten first.
 */

export interface PageScroll {
  x: number;
  y: number;
}

const MAX_PLACES = 256;

const places = new Map<string, PageScroll>();

/**
 * The key a place keeps its page's position under: the place (`tab`, the panel key; `card`, the
 * thread and item) and the file, so a place showing another file never gets this one's.
 */
export function pageScrollKey(...parts: string[]): string {
  return parts.join("\u0000");
}

/** Notes where the page at `key` is; the top forgets it. */
export function keepPageScroll(key: string, at: PageScroll): void {
  places.delete(key);
  if (at.x <= 0 && at.y <= 0) return;
  places.set(key, { x: at.x, y: at.y });
  if (places.size > MAX_PLACES) {
    const oldest = places.keys().next();
    if (!oldest.done) places.delete(oldest.value);
  }
}

/** Where the page at `key` was left; null for its top. */
export function pageScrollOf(key: string): PageScroll | null {
  return places.get(key) ?? null;
}

/** Forgets every place (tests). */
export function resetPageScroll(): void {
  places.clear();
}

/** A document's `{ type: "cf:scroll", x, y, path }` (frame.js); null for any other message. */
export function pageScrollNote(data: unknown): (PageScroll & { path: string }) | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== "cf:scroll" || typeof m.path !== "string") return null;
  const x = Number(m.x);
  const y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), path: m.path };
}

/** The path a frame URL names (what its document's `location.pathname` is); "" for one that does not parse. */
export function framePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
