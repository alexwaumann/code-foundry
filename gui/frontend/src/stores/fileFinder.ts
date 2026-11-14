/**
 * The file finder's presentation and its two actions (file.find, cmd+P;
 * docs/notes/file-finder-2-gui.md). The finder is a page of the command palette
 * (components/palette/FileFinder.tsx) over the thread on screen. Enter opens the file as
 * a File tab beside that thread; ⌥⏎ puts it in the thread's prompt as an @ file.
 */
import { threadDraftKey } from "@/lib/threadDraft";
import { isNoProject } from "@/lib/threadRow";
import { insertTagInto } from "./cite";
import { openFileInPanel } from "./filePanel";
import { threadTarget } from "@/shell/host";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

/** A file the finder lists: a path relative to one of the thread's checkouts. */
export interface FinderFile {
  projectId: string;
  /** Absolute path of the checkout. */
  checkout: string;
  /** Relative to the checkout. */
  path: string;
}

/** Whether the finder has something to search for a thread: it has a project (or workspace). */
export function canFindIn(threadId: string): boolean {
  const t = useThreadsStore.getState().byId[threadId];
  return t !== undefined && !isNoProject(t, useProjectsStore.getState());
}

/**
 * file.find in this window: the palette's file finder over the selected thread. Deferred,
 * so that picked in the palette (which closes after a presenter runs) it reopens on the
 * finder. Without a thread with a project on screen (the CLI's ShowView reaches every
 * window) nothing opens; the command is still handled, never invoked again.
 */
export function presentFileFinder(): boolean {
  const sel = useUiStore.getState().selection;
  if (sel.kind !== "thread" || !canFindIn(sel.id)) return true;
  const threadId = sel.id;
  queueMicrotask(() => {
    useUiStore.getState().openFilesPalette(threadId);
  });
  return true;
}

/**
 * Enter: the file as a File tab linked to the thread (placed by the layout; an open tab of the
 * file only activates), at `line` when given, with the keyboard in it. The palette closes
 * without handing the keyboard to the thread's prompt: until the tab draws, it is back where
 * it was.
 */
export function openFoundFile(threadId: string, f: FinderFile, line?: number): void {
  useUiStore.getState().closePalette(true);
  openFileInPanel(threadTarget(threadId), { project: f.projectId, base: f.checkout, path: f.path, ...(line === undefined ? {} : { line }) });
}

/**
 * ⌥⏎: the file as an @ file tag (the same tag the prompt's @ completion inserts) at the
 * caret of the thread's prompt. The palette closes and the prompt takes the keyboard.
 */
export function tagFoundFile(threadId: string, f: FinderFile): void {
  useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "content" } }));
  useUiStore.getState().closePalette();
  // After the palette has closed and handed the keyboard back to the prompt.
  requestAnimationFrame(() => {
    insertTagInto(threadDraftKey(threadId), { tagKind: "file", projectId: f.projectId, path: f.path });
  });
}
