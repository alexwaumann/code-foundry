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
