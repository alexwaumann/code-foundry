import type { FileReadView } from "@/api/files";

/** How many files' parses are kept (the tabs open at once, roughly). */
const KEEP = 8;

/**
 * A parse made once per file contents: the File tab reads again on every worktree change,
 * and a read with the same text (and the same cut) gets the same parse back, so the views'
 * state that hangs on it (which JSON nodes are open) survives. The last KEEP files only.
 */
export function memoByText<T>(make: (text: string, path: string, truncated: boolean) => T): (file: FileReadView, path: string) => T {
  const kept = new Map<string, { text: string; truncated: boolean; value: T }>();
  return (file, path) => {
    const text = file.text ?? "";
    const hit = kept.get(path);
    if (hit && hit.text === text && hit.truncated === file.truncated) {
      // Most recent last.
      kept.delete(path);
      kept.set(path, hit);
      return hit.value;
    }
    const value = make(text, path, file.truncated);
    kept.delete(path);
    kept.set(path, { text, truncated: file.truncated, value });
    for (const k of kept.keys()) {
      if (kept.size <= KEEP) break;
      kept.delete(k);
    }
    return value;
  };
}
