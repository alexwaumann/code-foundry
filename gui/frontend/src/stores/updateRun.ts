/**
 * "Update all" on Settings → Skills and Settings → Plugins (docs/notes/skills-page-redesign.md):
 * the page's own per-item update commands, one at a time. A row's busy state and failure are
 * its store's; this keeps what only the run knows: how far it is ("Updating 2 of 3…") and
 * which rows it finished, which stay where they are reading "Updated to X" until the page is
 * next opened (a re-read would otherwise take them from under the pointer mid-run).
 */
import { create } from "zustand";

export type UpdateScope = "skills" | "plugins";

export interface UpdateRun {
  running: boolean;
  /** The step in progress, from 1. */
  at: number;
  total: number;
  /** The rows the runs finished, by key: the version each went to. */
  updated: Readonly<Record<string, string>>;
}

/** One row's update. `run` says whether it worked; its failure is the row's own to show. */
export interface UpdateStep {
  key: string;
  version: string;
  run: () => Promise<boolean>;
}

const idle: UpdateRun = { running: false, at: 0, total: 0, updated: {} };

export const useUpdateRunStore = create<Record<UpdateScope, UpdateRun>>()(() => ({ skills: idle, plugins: idle }));

function patch(scope: UpdateScope, f: (r: UpdateRun) => Partial<UpdateRun>): void {
  useUpdateRunStore.setState((s) => ({ [scope]: { ...s[scope], ...f(s[scope]) } }));
}

/** Runs the steps in order; one that fails does not stop the rest. A run in progress is left alone. */
export async function runUpdates(scope: UpdateScope, steps: readonly UpdateStep[]): Promise<void> {
  if (steps.length === 0 || useUpdateRunStore.getState()[scope].running) return;
  patch(scope, () => ({ running: true, at: 0, total: steps.length }));
  for (const [i, step] of steps.entries()) {
    patch(scope, () => ({ at: i + 1 }));
    const done = await step.run().catch(() => false);
    if (done) patch(scope, (r) => ({ updated: { ...r.updated, [step.key]: step.version } }));
  }
  patch(scope, () => ({ running: false }));
}

/** A page opens: last time's "Updated to X" rows go back to their groups. A run in progress keeps its own. */
export function forgetUpdated(scope: UpdateScope): void {
  if (!useUpdateRunStore.getState()[scope].running) useUpdateRunStore.setState({ [scope]: idle });
}

/** Back to nothing run (tests). */
export function resetUpdateRuns(): void {
  useUpdateRunStore.setState({ skills: idle, plugins: idle });
}
