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

/** Short label for a terminal: its title, else the program name. */
export function terminalLabel(t: { title: string; argv: readonly string[]; id: string }): string {
  if (t.title) return t.title;
  const [prog, ...args] = t.argv;
  return prog ? [basename(prog), ...args].join(" ") : t.id;
}
