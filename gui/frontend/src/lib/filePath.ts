/**
 * Paths as the File and Diff tabs handle them: "/"-separated, macOS. Pure string work: no
 * symlinks are followed (the daemon resolves the real file).
 */

/** "." and ".." segments folded, repeated and trailing slashes dropped ("/" stays). ".." never climbs above the root. */
export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (seg !== ".." || !abs) out.push(seg);
  }
  const joined = out.join("/");
  return abs ? `/${joined}` : joined || ".";
}

/**
 * `path` made absolute against `base` when it is relative and base is absolute; an absolute
 * path is only normalized, and "~"/"~/…" (the daemon expands them) or a relative path
 * without an absolute base come back as they were.
 */
export function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) return normalizePath(path);
  if (path === "~" || path.startsWith("~/") || !base.startsWith("/")) return path;
  return normalizePath(`${base}/${path}`);
}

/** The last segment ("a/b/c.ts" → "c.ts"). */
export function fileName(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

/** Everything before the last segment, with its trailing slash ("a/b/c.ts" → "a/b/"); "" without one. */
export function dirPart(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i < 0 ? "" : t.slice(0, i + 1);
}

/** The lowercased extension without its dot ("README.MD" → "md"); "" for none or a dotfile. */
export function extOf(p: string): string {
  const name = fileName(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** `path` relative to `root` when inside it ("/w/a/b.ts" in "/w" → "a/b.ts"); null otherwise. */
export function relativeTo(path: string, root: string): string | null {
  const r = root.replace(/\/+$/, "");
  if (!r || !path.startsWith(`${r}/`)) return null;
  return path.slice(r.length + 1);
}
