/**
 * The item ids a timeline row shows: its id, ids and permissionId, and those of its nested
 * nodes (an Agent's children, a strip's nodes and latest step). Generic over row shapes so
 * it serves the thread's rows and the subagent view's alike (components/thread/RowError).
 */
export function rowItemIds(row: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "id" || k === "permissionId") && typeof x === "string" && x) out.push(x);
      else if (k === "ids" && Array.isArray(x)) out.push(...x.filter((s): s is string => typeof s === "string" && s !== ""));
      else if (k === "children" || k === "nodes" || k === "latest") walk(x);
    }
  };
  walk(row);
  return [...new Set(out)];
}
