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
