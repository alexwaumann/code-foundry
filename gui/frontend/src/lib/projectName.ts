/** The primary keyword (lib/workspaceCard.ts PRIMARY_WORKSPACE; not imported: the mock imports this file and has no @ alias). */
const PRIMARY_WORKSPACE = "workspace";

/** Another project, for projectRenameError: its id and name. */
export interface NamedProject {
  id: string;
  name: string;
}

/**
 * A project's new name as the daemon takes it (internal/store/project/rename.go CheckName): trimmed, one line of
 * at most 100 bytes, no "/" or "," (refs read those as paths and lists), not "~" or "workspace", not another
 * project's id or (whatever the case) name; "" when fine.
 */
export function projectRenameError(name: string, others: readonly NamedProject[] = []): string {
  const n = name.trim().normalize("NFC");
  if (!n) return "Name it.";
  if (new TextEncoder().encode(n).length > 100) return "At most 100 bytes.";
  if (hasControl(n)) return "One line.";
  if (/[/,]/.test(n) || n === "~") return "No / or , in a project name.";
  if (n.toLowerCase() === PRIMARY_WORKSPACE) return "“workspace” is reserved.";
  const lower = n.toLowerCase();
  for (const o of others) {
    if (o.id.toLowerCase() === lower) return `“${n}” is another project’s id.`;
    if (o.name.normalize("NFC").toLowerCase() === lower) return `A project named “${o.name}” exists.`;
  }
  return "";
}

/** Go's unicode.IsControl on any character: C0, DEL and C1 (all in the BMP, so UTF-16 units suffice). */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return true;
  }
  return false;
}
