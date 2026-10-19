import { useEffect, useId, useState, type RefObject } from "react";
import { appInfo, onFilesDropped, pickFiles } from "@/api/app";
import { errorMessage } from "@/api/stream";
import { pathsAsText, splitDroppedPaths } from "@/lib/droppedPaths";
import { addAttachmentPaths, getDraft, updateDraft } from "@/stores/compose";
import type { PromptEditorHandle } from "./PromptEditor";

/**
 * The attach button's label: in the Wails host it opens the native panel, which takes any
 * file or folder (images and PDFs are attached, other paths inserted as text); in a
 * browser the file input takes images and PDFs only.
 */
export function attachLabel(hosted: boolean): string {
  return hosted ? "Attach files" : "Attach images or PDFs";
}

/** Whether the page runs in the Wails host: false until appInfo() answers (browser dev and e2e stay false). */
export function useHosted(): boolean {
  const [hosted, setHosted] = useState(false);
  useEffect(() => {
    let live = true;
    void appInfo().then((info) => {
      if (live) setHosted(info !== null);
    });
    return () => {
      live = false;
    };
  }, []);
  return hosted;
}

/**
 * Routes dropped or picked paths into a draft: images and PDFs are staged and attached
 * (chips at the caret once they are), any other path, folders included, goes into the
 * prompt as text at the caret (lib/droppedPaths). Nothing happens while the draft is
 * sending.
 */
export async function routePaths(draftKey: string, editorRef: RefObject<PromptEditorHandle | null>, paths: readonly string[]): Promise<void> {
  if (getDraft(draftKey).phase !== "idle") return;
  const { attach, insert } = splitDroppedPaths(paths);
  if (insert.length > 0) editorRef.current?.insertPlain(pathsAsText(insert));
  const added = await addAttachmentPaths(draftKey, attach);
  editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
}

/** The attributes that make an element a native drop target with this id (the Wails runtime reads them). */
export interface DropTargetProps {
  "data-file-drop-target"?: "";
  "data-drop-id": string;
}

/**
 * A composer's native file handling in the Wails host (docs/notes/attach-drop.md). The host
 * takes OS file drags (the page gets no DOM drop for them) and reports a drop on an
 * element with `data-file-drop-target` as `app:files-dropped` with the element's
 * `data-drop-id`: `dropTarget` goes on the composer's drop surface, with an id of its
 * own, and only drops on it are routed here. While `disabled` (a send in flight) the
 * surface is no drop target, so a drop on it does nothing. `pick` shows the native open
 * panel at startDir (else home) and routes the choice the same way; `hosted` says
 * whether it can (without a host the composer keeps its `<input type="file">`).
 */
export function useHostFiles({
  draftKey,
  editorRef,
  disabled,
  startDir,
}: {
  draftKey: string;
  editorRef: RefObject<PromptEditorHandle | null>;
  disabled: boolean;
  startDir: string;
}): { dropTarget: DropTargetProps; hosted: boolean; pick: () => void } {
  const dropId = useId();
  const hosted = useHosted();

  useEffect(
    () =>
      onFilesDropped(({ paths, target }) => {
        if (target === dropId) void routePaths(draftKey, editorRef, paths);
      }),
    [dropId, draftKey, editorRef],
  );

  const pick = () => {
    void (async () => {
      try {
        const paths = await pickFiles(startDir);
        if (paths && paths.length > 0) await routePaths(draftKey, editorRef, paths);
      } catch (err) {
        updateDraft(draftKey, { notice: errorMessage(err) });
      }
    })();
  };

  return { dropTarget: disabled ? { "data-drop-id": dropId } : { "data-file-drop-target": "", "data-drop-id": dropId }, hosted, pick };
}
