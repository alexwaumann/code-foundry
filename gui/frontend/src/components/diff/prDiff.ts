/**
 * A pull request's diff from GitHub (components/pr/diffModel.ts parsePrDiff) as the Diff tab's
 * file list reads a checkout's comparison: rows and counts, so the list, its keys and its steps
 * are the same code (docs/notes/pr-diff-tab.md). Pure.
 */
import type { PrDiffFile, PrDiffModel } from "@/components/pr/diffModel";
import type { ListedView } from "./FileList";
import type { FileRow } from "./files";

/** The list's rows, in the diff's order (a pull request has no conflicts to put first). */
export function prFileRows(model: PrDiffModel): FileRow[] {
  return model.files.map(
    (f): FileRow => ({
      key: `f:${f.path}`,
      dir: f.dir,
      name: f.name,
      path: f.path,
      status: f.status,
      added: f.added,
      deleted: f.deleted,
      binary: f.binary,
      submodule: false,
      conflict: false,
      oldPath: f.prevPath,
    }),
  );
}

/** The counts the list and the files control show: every file the diff holds. */
export function prListedView(model: PrDiffModel): ListedView {
  return { files: model.files, totalFiles: model.files.length, totalAdded: model.added, totalDeleted: model.deleted, truncated: false, skippedNames: 0 };
}

/** The diff's file a row names, by path; undefined for a row no longer in the diff. */
export function prFileOf(model: PrDiffModel, row: FileRow): PrDiffFile | undefined {
  return model.files.find((f) => f.path === row.path);
}
