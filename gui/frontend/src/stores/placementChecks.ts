/**
 * The daemon's placement check (ThreadService.CheckPlacement, thread.placement.check) for
 * branches the composer's Work in picker and the card's Run in menu show: a branch whose
 * worktree moved (or whose main checkout holds it) is greyed with the refusal the Create
 * would give, so the user learns before sending (docs/notes/thread-project-set.md). Only
 * the candidates lib/placementCandidates finds are asked; each answer is cached per set,
 * branch and signature, so it is asked again when the worktree that made it one changes.
 */
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { checkPlacement, type PlacementView } from "@/api/placement";
import { placementCandidates, type CandidateProject } from "@/lib/placementCandidates";
import { useProjectsStore } from "./projects";
import { createResource } from "./resource";

const SEP = "\u0000";

/** A worktree-mode check of a set on a branch; key: "<ids,>\0<branch>\0<signature>". */
export const placementResource = createResource<PlacementView>((key, signal) => {
  const [ids = "", branch = ""] = key.split(SEP);
  return checkPlacement({ projectIds: ids.split(","), branch, checkoutMode: false }, undefined, signal);
});

/** The refusal text of a check: its refused members' messages, one per line; "" when none. */
export function refusalOf(p: PlacementView | null | undefined): string {
  return (p?.members ?? [])
    .filter((m) => m.outcome === "refused")
    .map((m) => m.message.replace(/^failed precondition: /, ""))
    .join("\n");
}

/** The projects of `ids` as the candidate rule reads them, as one string (a narrow selector). */
function useCandidateProjects(ids: readonly string[]): CandidateProject[] {
  const key = useProjectsStore(
    useShallow((s) =>
      ids.map((id) => {
        const r = s.byId[id];
        if (!r) return "";
        return JSON.stringify({ id, git: r.git, worktrees: r.worktrees.map((w) => ({ path: w.path, branch: w.branch, detached: w.detached, isMain: w.isMain })) });
      }),
    ),
  );
  return useMemo(() => key.filter(Boolean).map((k) => JSON.parse(k) as CandidateProject), [key]);
}

/** One question for the daemon: would a worktree-mode thread over `projectIds` on `branch` be refused? `id` names its answer. */
export interface RefusalCheck {
  id: string;
  projectIds: readonly string[];
  branch: string;
}

/**
 * The refusal of each check the daemon would refuse, by check id (absent: allowed, not a
 * candidate, or not answered yet). `enabled` false asks nothing (a closed picker).
 */
export function useRefusals(checks: readonly RefusalCheck[], enabled = true): Readonly<Record<string, string>> {
  const allIds = useMemo(() => [...new Set(checks.flatMap((c) => c.projectIds))].sort(), [checks]);
  const projects = useCandidateProjects(allIds);
  const keys = useMemo(() => {
    if (!enabled) return [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    return checks.flatMap((c) => {
      const set = c.projectIds.flatMap((id) => byId.get(id) ?? []);
      const ids = [...c.projectIds].sort().join(",");
      return ids ? placementCandidates(set, [c.branch]).map((x) => ({ id: c.id, key: [ids, x.branch, x.signature].join(SEP) })) : [];
    });
  }, [enabled, checks, projects]);
  const joined = keys.map((k) => k.key).join(SEP + SEP);
  useEffect(() => {
    if (!joined) return;
    const releases = joined.split(SEP + SEP).map((k) => placementResource.watch(k));
    return () => {
      for (const r of releases) r();
    };
  }, [joined]);
  const texts = placementResource.store(useShallow((s) => keys.map((k) => refusalOf(s.entries[k.key]?.data))));
  return useMemo(() => {
    const out: Record<string, string> = {};
    keys.forEach((k, i) => {
      const text = texts[i];
      if (text) out[k.id] = text;
    });
    return out;
  }, [keys, texts]);
}

/** useRefusals for one set on each of `branches`, by branch (the composer's Work in list). */
export function usePlacementRefusals(projectIds: readonly string[], branches: readonly string[], enabled = true): Readonly<Record<string, string>> {
  const ids = projectIds.join(",");
  const checks = useMemo(() => {
    const set = ids ? ids.split(",") : [];
    return branches.map((b) => ({ id: b, projectIds: set, branch: b }));
  }, [ids, branches]);
  return useRefusals(checks, enabled);
}

/** useRefusals for each project alone on `branch`, by project id (a worktree-mode thread's members and candidates). */
export function useProjectRefusals(projectIds: readonly string[], branch: string, enabled = true): Readonly<Record<string, string>> {
  const ids = projectIds.join(",");
  const checks = useMemo(() => (ids && branch ? ids.split(",").map((id) => ({ id, projectIds: [id], branch })) : []), [ids, branch]);
  return useRefusals(checks, enabled);
}
