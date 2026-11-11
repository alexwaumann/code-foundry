import { memo, useCallback, useEffect, useMemo } from "react";
import { EditProvider, File, type EditorFactory, type FileEditChangeHandler, type FileOptions, type SelectedLineRange } from "@pierre/diffs/react";
import { createCodeEditor, editorHandle, type CodeEditor, type EditorHandle } from "@/lib/codeEditor";
import { useCodeTheme } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";
import { useCodeViewStore } from "@/stores/codeView";
import { CODE_SHADOW_CSS } from "./codeCss";
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
  /** An editor is about to open on `stateKey`. */
  onOpening: (stateKey: string) => void;
  /** The editor let go of `stateKey`: its tab left, it was turned off, or its document started over. */
  onDetached: (stateKey: string) => void;
  /** The editor is ready, after attaching to a file. */
  onReady: (editor: EditorHandle) => void;
  /** While editing, a marked line stays marked (a thread pointed at it); otherwise the only selection is the caret's. */
  mark: boolean;
}

// How many mounted views hold each draft key. Mounts come and go in one commit (StrictMode's
// second run; a tab moved to the other group, whose new editor resumes the key), so an
// editor has let go of a key only when, once the commit is over, no view holds it.
const holders = new Map<string, number>();

function hold(stateKey: string, change: 1 | -1): number {
  const n = (holders.get(stateKey) ?? 0) + change;
  if (n > 0) holders.set(stateKey, n);
  else holders.delete(stateKey);
  return n;
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
    (): FileOptions<undefined, undefined> => ({ theme, themeType, disableFileHeader: true, disableLineNumbers: !lineNumbers, overflow, unsafeCSS: CODE_SHADOW_CSS }),
    [theme, themeType, lineNumbers, overflow],
  );
  const host = useCodeHost();
  return (
    <div ref={host} className={cn("cf-code-view", className)} data-code-editor={edit?.active ? edit.stateKey : undefined}>
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
  const { active, stateKey, revision, onChange, onOpening, onDetached, onReady, mark } = edit;
  const onEditChange = useMemo<FileEditChangeHandler<undefined, undefined>>(
    () => (event) => {
      onChange(event.editor.getText());
    },
    [onChange],
  );
  const editorOptions = useMemo(
    () => ({
      onAttach: (editor: CodeEditor) => {
        onReady(editorHandle(editor));
      },
    }),
    [onReady],
  );
  const createEditor = useCallback<EditorFactory<undefined, undefined>>(
    (type, options, key) => {
      if (key !== undefined) onOpening(key);
      return createCodeEditor(type, options, key);
    },
    [onOpening],
  );
  // A passive effect: the library lets go in the commit, so its draft can be dropped by now.
  useEffect(() => {
    if (!active || stateKey === undefined) return;
    hold(stateKey, 1);
    return () => {
      hold(stateKey, -1);
      queueMicrotask(() => {
        if (!holders.has(stateKey)) onDetached(stateKey);
      });
    };
  }, [active, stateKey, onDetached]);
  return (
    <EditProvider createEditor={createEditor}>
      <File key={revision} file={file} options={options} selectedLines={active && !mark ? null : selectedLines} edit={active} editStateKey={stateKey} editorOptions={editorOptions} onEditChange={onEditChange} />
    </EditProvider>
  );
}
