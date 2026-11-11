/**
 * Skills and slash commands the composer offers after "/" (FilesystemService.ListSkills),
 * cached per source list (lib/completion skillSourcesKey: the draft's projects and their
 * checkouts) with the user's included. The composer loads its list on mount and whenever
 * its members change; a reload keeps showing the previous list.
 */
import { create } from "zustand";
import { listSkills, type SkillSourceView, type SkillView } from "@/api/filesystem";
import { skillSourcesKey } from "@/lib/completion";

export interface SkillsEntry {
  status: "loading" | "ready" | "error";
  skills: readonly SkillView[];
}

interface SkillsState {
  byKey: Readonly<Record<string, SkillsEntry>>;
}

export const useSkillsStore = create<SkillsState>()(() => ({ byKey: {} }));

/** ListSkills, replaceable in tests. */
export type ListSkillsFn = (sources: readonly SkillSourceView[], includeUser: boolean) => Promise<SkillView[]>;

const inFlight = new Map<string, Promise<void>>();

function set(key: string, entry: SkillsEntry): void {
  useSkillsStore.setState((s) => ({ byKey: { ...s.byKey, [key]: entry } }));
}

/**
 * Loads (or reloads) the skills of a source list plus the user's. Concurrent loads of
 * one list share a request. A failed reload keeps a list that loaded before.
 */
export function loadSkills(sources: readonly SkillSourceView[], list: ListSkillsFn = listSkills): Promise<void> {
  const key = skillSourcesKey(sources);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const prev = useSkillsStore.getState().byKey[key];
  if (!prev) set(key, { status: "loading", skills: [] });
  const run = (async () => {
    try {
      const skills = await list(sources, true);
      set(key, { status: "ready", skills });
    } catch {
      if (prev?.status === "ready") return;
      set(key, { status: "error", skills: [] });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}

const NONE: readonly SkillView[] = [];

/** The loaded skills of a source list (empty while loading or on error). */
export function useSkills(key: string): readonly SkillView[] {
  return useSkillsStore((s) => s.byKey[key]?.skills ?? NONE);
}

/**
 * The description of a skill, from whichever cached list has it ("" when none does):
 * a tag's tooltip, which knows only the tag.
 */
export function useSkillDescription(projectId: string, name: string): string {
  return useSkillsStore((s) => {
    for (const entry of Object.values(s.byKey)) {
      const hit = entry.skills.find((k) => k.name === name && (projectId === "" ? k.scope === "user" : k.projectId === projectId));
      if (hit) return hit.description;
    }
    return "";
  });
}

/** Test helper: forgets everything. */
export function resetSkills(): void {
  inFlight.clear();
  useSkillsStore.setState({ byKey: {} });
}
