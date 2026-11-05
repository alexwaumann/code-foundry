import { memo, useEffect, useMemo, useRef } from "react";
import { EditProvider, File, type FileEditChangeHandler, type FileOptions, type SelectedLineRange } from "@pierre/diffs/react";
import { createCodeEditor } from "@/lib/codeEditor";
import { useCodeTheme } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";
import { useCodeViewStore } from "@/stores/codeView";
import { useCodeHost } from "./useCodeHost";
import "./code.css";

/**
 * Makes a CodeFile editable. Only the File tab passes it, always (with `active` off while
 * it views), so the tree does not change shape and the view turns into the editor in
 * place. Without it a CodeFile is read-only and the editor's code never loads.
 */
export interface CodeFileEdit {
  /** The editor is on; lib/codeEditor.ts's loadCodeEditor must have finished. */
  active: boolean;
  /** Names the draft while active: an editor coming back on this key resumes its document and undo history. */
  stateKey?: string | undefined;
  /** Goes up to start a new document: the old editor goes, the new one takes `contents`. */
  revision: number;
  /** The document changed. */
  onChange: (text: string) => void;
  /** The editor let go of `stateKey`: its tab left, it was turned off, or its document started over. */
  onDetached: (stateKey: string) => void;
  /** The editor is ready, after attaching to a file. */
  onReady?: ((focus: () => void) => void) | undefined;
}

export interface CodeFileProps {
  /** The file name (or path): the language comes from its extension. */
  name: string;
  contents: string;
  /** Long lines wrap instead of scrolling; the codeView store's choice when unset. */
  wrap?: boolean;
  /** Line numbers in the gutter (on by default). */
  lineNumbers?: boolean;
  /** Lines to mark as selected (a File tab's line). Given, even as null, the selection is controlled: clicks do not change it. */
  selectedLines?: SelectedLineRange | null;
  /** The File tab's edit mode; read-only without it. */
  edit?: CodeFileEdit;
  className?: string;
}

/**
 * A highlighted file on @pierre/diffs with the house options: the app theme (lib/codeTheme),
 * no file header (callers draw their own outside it), line numbers on, wrap from the
 * codeView store. Read-only unless given `edit`.
 */
export const CodeFile = memo(function CodeFile({ name, contents, wrap, lineNumbers = true, selectedLines, edit, className }: CodeFileProps) {
  const { theme, themeType } = useCodeTheme();
  const storeWrap = useCodeViewStore((s) => s.wrap);
  const overflow = (wrap ?? storeWrap) ? "wrap" : "scroll";
  const file = useMemo(() => ({ name, contents }), [name, contents]);
  const options = useMemo(
    (): FileOptions<undefined, undefined> => ({ theme, themeType, disableFileHeader: true, disableLineNumbers: !lineNumbers, overflow }),
    [theme, themeType, lineNumbers, overflow],
  );
  const host = useCodeHost();
  return (
    <div ref={host} className={cn("cf-code-view", className)} data-code-editor={edit?.active ? "" : undefined}>
      {edit ? (
        <EditableFile file={file} options={options} selectedLines={selectedLines} edit={edit} />
      ) : selectedLines === undefined ? (
        <File file={file} options={options} />
      ) : (
        <File file={file} options={options} selectedLines={selectedLines} />
      )}
    </div>
  );
});

/** The File tab's view of a file: the library's File under its editor context. */
function EditableFile({ file, options, selectedLines, edit }: { file: { name: string; contents: string }; options: FileOptions<undefined, undefined>; selectedLines: SelectedLineRange | null | undefined; edit: CodeFileEdit }) {
  const { active, stateKey, revision, onChange, onDetached, onReady } = edit;
  const onEditChange = useMemo<FileEditChangeHandler<undefined, undefined>>(
    () => (event) => {
      onChange(event.editor.getText());
    },
    [onChange],
  );
  const editorOptions = useMemo(
    () => ({
      onAttach: (editor: { focus: () => void }) => {
        onReady?.(() => {
          editor.focus();
        });
      },
    }),
    [onReady],
  );
  // A passive effect: the library lets go in the commit, so its draft can be dropped by
  // now. A microtask later, and only if nothing took the key up again: StrictMode runs this
  // cleanup and the effect back to back on a new component, whose editor stays.
  const held = useRef<string | null>(null);
  useEffect(() => {
    if (!active || stateKey === undefined) return;
    held.current = stateKey;
    return () => {
      held.current = null;
      queueMicrotask(() => {
        if (held.current !== stateKey) onDetached(stateKey);
      });
    };
  }, [active, stateKey, onDetached]);
  return (
    <EditProvider createEditor={createCodeEditor}>
      {/* While editing, the only selection is the caret's. */}
      <File key={revision} file={file} options={options} selectedLines={active ? null : selectedLines} edit={active} editStateKey={stateKey} editorOptions={editorOptions} onEditChange={onEditChange} />
    </EditProvider>
  );
}
