import { useShallow } from "zustand/react/shallow";
import type { OptionsSource, SelectOption } from "@/api/plugin";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

/** One option per line ("value\u0000label"), so the selectors stay shallow-stable. */
function decode(rows: readonly string[]): SelectOption[] {
  return rows.map((r) => {
    const [value = "", label = ""] = r.split("\u0000");
    return { key: value, value, label: label || value };
  });
}

/**
 * A select's host-filled options (DECISIONS.md, option sources): the projects, or the
 * threads that are not archived (newest last, as the store orders them), kept current.
 */
export function useSourceOptions(source: OptionsSource | undefined): SelectOption[] | null {
  const projects = useProjectsStore(useShallow((s) => (source === "projects" ? s.order.map((id) => `${id}\u0000${s.byId[id]?.name ?? ""}`) : [])));
  const threads = useThreadsStore(
    useShallow((s) => (source === "threads" ? s.order.filter((id) => s.byId[id] && s.byId[id].archivedAtMs === null).map((id) => `${id}\u0000${s.byId[id]?.name ?? ""}`) : [])),
  );
  if (source === "projects") return decode(projects);
  if (source === "threads") return decode(threads);
  return null;
}
