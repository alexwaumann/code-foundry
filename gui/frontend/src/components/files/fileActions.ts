/** The File and Diff tabs' Open in editor and Open in Finder: the worktree commands with a file. */
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";

/** Where a file lives for the editor and Finder commands: its project and the directory they run in. */
export interface FilePlace {
  project: string;
  /** The worktree (or home, for a file outside any project): worktree.open.editor's and worktree.reveal's worktree. */
  dir: string;
  /** Absolute path of the file. */
  file: string;
}

/** worktree.open.editor with the file (and line, where the editor takes one). */
export function openInEditor(p: FilePlace, line?: number): void {
  const args: Record<string, string> = { worktree: p.dir, file: p.file };
  if (line !== undefined && line > 0) args.line = String(line);
  void runCommand("worktree.open.editor", args, worktreeContext(p.project, p.dir));
}

/** worktree.reveal with the file: Finder selects it. */
export function revealInFinder(p: FilePlace): void {
  void runCommand("worktree.reveal", { worktree: p.dir, file: p.file }, worktreeContext(p.project, p.dir));
}
