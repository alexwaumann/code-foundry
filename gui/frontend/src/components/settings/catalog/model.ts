/**
 * The list Settings → Skills and Settings → Plugins share (docs/notes/skills-page-redesign.md):
 * one card of group headers and rows, flat so VirtualStack can virtualise it. Pure.
 */
import type { UpdateRun } from "@/stores/updateRun";

/** A list's ids, flat: "#<group>" opens a group, the ids after it are its rows. */
const GROUP_MARK = "#";

/** A group's id in a flat list. */
export function groupId(id: string): string {
  return `${GROUP_MARK}${id}`;
}

/**
 * The flat ids of some groups, empty ones left out. Strings, so a store selector can give
 * them to useShallow: the list re-renders when a row moves, not on every read.
 */
export function flatIds(groups: readonly (readonly [string, readonly string[]])[]): string[] {
  return groups.flatMap(([id, rows]) => (rows.length > 0 ? [groupId(id), ...rows] : []));
}

export type CatalogEntry = { kind: "group"; id: string; count: number } | { kind: "row"; key: string };

/** A flat list as its groups (with how many rows each has) and rows. */
export function catalogEntries(ids: readonly string[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  let group: Extract<CatalogEntry, { kind: "group" }> | null = null;
  for (const id of ids) {
    if (id.startsWith(GROUP_MARK)) {
      group = { kind: "group", id: id.slice(GROUP_MARK.length), count: 0 };
      out.push(group);
      continue;
    }
    if (group) group.count++;
    out.push({ kind: "row", key: id });
  }
  return out;
}

/** Whether every word is in one of the fields (words as settings/model.ts queryWords gives them; none match everything). */
export function matchesWords(words: readonly string[], fields: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = fields.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A count as the page writes it: "1,240". */
export function countWords(n: number): string {
  return n.toLocaleString("en-US");
}

/** The search field's words: what it searches, with the real count; "Search installed" with nothing to install from. */
export function searchPlaceholder(browsing: boolean, count: number | null, where: { place: string; browse: string }): string {
  if (browsing) return where.browse;
  if (count === null) return `Search installed and ${where.place}`;
  return count > 0 ? `Search installed and the ${countWords(count)} in ${where.place}` : "Search installed";
}

/** The Needs you header's button: null unless a run is going or more than one update is there to run. */
export function updateAllWords(run: Pick<UpdateRun, "running" | "at" | "total">, available: number): string | null {
  if (run.running) return `Updating ${String(run.at)} of ${String(run.total)}…`;
  return available > 1 ? `Update all ${String(available)}` : null;
}

/** When something was read: "read just now", "read 5 min ago", "read 3 h ago", "read 2 d ago"; "not read yet". */
export function readWords(ms: number | null, now: number): string {
  if (ms === null) return "not read yet";
  const mins = Math.round(Math.max(0, now - ms) / 60_000);
  if (mins < 1) return "read just now";
  if (mins < 60) return `read ${String(mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `read ${String(hours)} h ago`;
  return `read ${String(Math.round(hours / 24))} d ago`;
}

/** The page menu's refresh hint: the newest read, as a sentence ("Read 5 min ago", "Not read yet"). */
export function readHint(times: readonly (number | null)[], now: number): string {
  const read = times.filter((ms) => ms !== null);
  const words = readWords(read.length > 0 ? Math.max(...read) : null, now);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
