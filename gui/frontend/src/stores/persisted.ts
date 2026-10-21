/**
 * Guards for state read back from localStorage. Every build that runs on this machine
 * shares the same WebKit localStorage, so a persisted store may hold another build's shape
 * (or anything at all): zustand's default merge would put a persisted `null` where the
 * reducers expect an object and the app would fail to boot (docs/notes/html-preview-
 * interactive.md, docs/notes/frontend-robustness.md). Each persisted store's `merge` keeps
 * only the fields it knows, of the right type, and falls back to the default otherwise.
 */

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The persisted state as a record ({} for null, an array, a number…). */
export function persistedRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** v when it is a finite number, else undefined. */
export function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** v when it is a boolean, else the fallback. */
export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** v when it is one of the allowed values, else the fallback. */
export function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback;
}

/** The entries of a persisted record that `entry` accepts (it returns undefined to drop one); {} for a non-record. */
export function recordOf<T>(v: unknown, entry: (x: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const e = entry(x);
    if (e !== undefined) out[k] = e;
  }
  return out;
}
