/**
 * The merge method each repository merges with by default: the Merge and Auto-merge split
 * buttons' main part and the merge dialog's first pick. Set the moment the user picks a
 * method (the Merge or Auto-merge menu, the merge dialog's Method), not when a merge
 * succeeds. Persisted (localStorage "code-foundry.mergeMethods"), like the reviewer
 * picker's recents (stores/reviewerRecents.ts): a per-repository preference of this
 * window, not a setting the daemon or the CLI reads. Keys are lower-case slugs;
 * repositories are never pruned.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MergeMethodView } from "@/api/gh";
import { persistedRecord, recordOf } from "./persisted";

const METHODS: readonly MergeMethodView[] = ["merge", "squash", "rebase"];

interface MergeDefaultsState {
  /** Lower-case repository slug → the method picked last there. */
  bySlug: Readonly<Record<string, MergeMethodView>>;
}

export const useMergeDefaultsStore = create<MergeDefaultsState>()(
  persist((): MergeDefaultsState => ({ bySlug: {} }), {
    name: "code-foundry.mergeMethods",
    version: 1,
    // Only known methods (stores/persisted.ts): another build's shape is dropped.
    merge: (persisted, current) => ({
      ...current,
      bySlug: recordOf(persistedRecord(persisted).bySlug, (v) => METHODS.find((m) => m === v)),
    }),
  }),
);

const slugKey = (slug: string): string => slug.toLowerCase();

/** The method picked last in slug's repository; undefined when none was. */
export function useMergeMethodDefault(slug: string): MergeMethodView | undefined {
  return useMergeDefaultsStore((s) => s.bySlug[slugKey(slug)]);
}

/** The method picked last in slug's repository, outside React. */
export function mergeMethodDefault(slug: string): MergeMethodView | undefined {
  return useMergeDefaultsStore.getState().bySlug[slugKey(slug)];
}

/** Makes method slug's repository's default (a pick in a merge menu or the merge dialog). */
export function setMergeMethodDefault(slug: string, method: MergeMethodView): void {
  const key = slugKey(slug);
  if (useMergeDefaultsStore.getState().bySlug[key] === method) return;
  useMergeDefaultsStore.setState((s) => ({ bySlug: { ...s.bySlug, [key]: method } }));
}
