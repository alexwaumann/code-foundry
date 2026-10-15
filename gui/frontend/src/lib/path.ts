/** Last path segment ("/a/b/" -> "b"). */
export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) || "/" : trimmed;
}

/** Abbreviates a macOS home directory prefix to "~". */
export function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** Whether `path` is `root` or inside it, on a path-segment boundary (trailing slashes ignored). */
export function isWithin(path: string, root: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const p = trim(path);
  const r = trim(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

/**
 * A path split for a middle ellipsis: the head (up to and including the last "/") can be
 * truncated while the tail (the last segment, e.g. a worktree's branch folder) stays.
 * Trailing slashes are dropped; a path without "/" is all tail.
 */
export function splitPathTail(p: string): { head: string; tail: string } {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  const i = trimmed.lastIndexOf("/");
  if (i < 0 || i === trimmed.length - 1) return { head: "", tail: trimmed };
  return { head: trimmed.slice(0, i + 1), tail: trimmed.slice(i + 1) };
}
