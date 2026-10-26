import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { defaultFilter } from "cmdk";
import { draftKey, HOME_KEY, projectSource } from "@/lib/compose";
import { NO_PROJECT } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspaceOrder, useWorkspacesStore } from "@/stores/workspaces";

/**
 * The project pickers' rows in their default order: workspace ids by name, project ids in
 * registry order, and whether projects have loaded. The composer's ProjectSwitcher shows
 * them grouped (ProjectRowGroups); cmd+N's ProjectPicker as one flat list (usePickerRows).
 * A row's cmdk value is its target's draftKey (lib/compose): the project id, or
 * "ws:<workspace id>"; "No project" is HOME_KEY.
 */
export function useProjectRows(): { workspaces: readonly string[]; projects: readonly string[]; loaded: boolean } {
  const projects = useProjectsStore(useShallow((s) => s.order));
  const loaded = useProjectsStore((s) => s.loaded);
  const workspaces = useWorkspaceOrder();
  return { workspaces, projects, loaded };
}

/** What a search matches on a project row: its name, path and source. */
export function projectSearchTerms(name: string, path: string, source: string): string[] {
  return [name, path, source];
}

/** What a search matches on the "No project" row. */
export const NO_PROJECT_TERMS: readonly string[] = [NO_PROJECT, "home", "~"];

/** Names sorted the way a workspace row lists its members: by name, case-insensitively. */
export const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** One row of cmd+N's flat list: its target, cmdk value, and the text a search scores. */
export type PickerRow = ({ kind: "none" } | { kind: "workspace"; id: string } | { kind: "project"; id: string }) & { value: string; text: string };

/**
 * cmd+N's rows in their default order: "No project" first (once projects have loaded),
 * then workspaces by name, then projects in registry order. Each carries the text a query
 * is scored against (rankPickerRows): the label and its keywords, as cmdk would join them.
 */
export function usePickerRows(): { rows: readonly PickerRow[]; workspaces: readonly string[]; projects: readonly string[]; loaded: boolean } {
  const { workspaces, projects, loaded } = useProjectRows();
  const projectTexts = useProjectsStore(
    useShallow((s) =>
      projects.map((id) => {
        const r = s.byId[id];
        return (r ? projectSearchTerms(r.name, r.path, projectSource(r)) : [id]).join(" ");
      }),
    ),
  );
  // A workspace's name, then its member project ids (one per line), resolved to names below.
  const workspaceRaw = useWorkspacesStore(
    useShallow((s) =>
      workspaces.map((id) => {
        const w = s.byId[id];
        return [w?.name ?? id, ...(w?.members ?? []).map((m) => m.projectId)].join("\n");
      }),
    ),
  );
  const workspaceTexts = useProjectsStore(
    useShallow((s) =>
      workspaceRaw.map((raw) => {
        const [name = "", ...members] = raw.split("\n");
        return [name, ...members.map((m) => s.byId[m]?.name ?? m).sort(byName)].join(" ");
      }),
    ),
  );
  const rows = useMemo<PickerRow[]>(
    () => [
      ...(loaded ? [{ kind: "none" as const, value: HOME_KEY, text: NO_PROJECT_TERMS.join(" ") }] : []),
      ...workspaces.map((id, i) => ({ kind: "workspace" as const, id, value: draftKey({ kind: "workspace", workspaceId: id }), text: workspaceTexts[i] ?? id })),
      ...projects.map((id, i) => ({ kind: "project" as const, id, value: id, text: projectTexts[i] ?? id })),
    ],
    [loaded, workspaces, projects, workspaceTexts, projectTexts],
  );
  return { rows, workspaces, projects, loaded };
}

/**
 * The rows a query shows, best first: cmdk's scorer (command-score) over each row's text;
 * a row scoring 0 is hidden and ties keep the default order. An empty query keeps every
 * row in the default order.
 */
export function rankPickerRows(rows: readonly PickerRow[], query: string): readonly PickerRow[] {
  const q = query.trim();
  if (q === "") return rows;
  return rows
    .map((row, i) => ({ row, i, score: defaultFilter(row.text, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.row);
}
