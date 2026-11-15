import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileQuestion, FileX, Folder, Pencil, SquareArrowOutUpRight, TriangleAlert } from "lucide-react";
import { canEdit, readFile, readFileTail, type FileReadView } from "@/api/files";
import type { SupportedLanguages } from "@pierre/diffs";
import type { CodeFileEdit } from "@/components/code/CodeFile";
import { draftText, type EditorHandle } from "@/lib/codeEditor";
import { FinderIcon } from "@/components/icons/AppIcon";
import { usePanelKey } from "@/shell/panelKeyContext";
import { Button } from "@/components/ui/button";
import { dirPart, fileName, relativeTo, resolvePath } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { setPreviewMode, useCodeViewStore } from "@/stores/codeView";
import { discardDraft, editClock, editorDetached, editorOpening, editPath, fileEditKey, focusEditor, focusNextEditor, noteDraft, noteEditor, noteRead, observeRead, reloadDraft, saveFile, startEdit, stopEdit, useFileEdit } from "@/stores/fileEdit";
import { noteFileKeyboard, readerPlaceOf, setFileFindDraft, useFileFindOpen } from "@/stores/fileFind";
import { canTell, dismissAsk, fileFacts, saveAndTell } from "@/stores/fileRequest";
import { fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { CodeBody } from "./CodeBody";
import { openInEditor, revealInFinder, type FilePlace } from "./fileActions";
import { ConflictBand, EditButtons, EditFailedBand, EditStatus } from "./FileEditBar";
import { FileRequestBand } from "./FileRequestBand";
import { FileActions, FileHeader, HeaderAction, HeaderMeta, ModeSwitch, WrapToggle } from "./FileHeader";
import { findMissing } from "./findMissing";
import { fileIconOf, formatSize, languageOf, lineCount, tailNotice, tooLargeHeading, truncatedNotice } from "./fileKind";
import { pickMode, previewKindOf, previewModes } from "./previews/registry";
import { SOURCE, type PreviewBodyProps, type PreviewKind, type PreviewRead } from "./previews/types";
import { FileFindBar } from "./FileFind";
import { FileEmptyState, FileLoading, NoticeBar } from "./states";
import { useFileHold } from "./useFileHold";
import { useDebounced, useFileChanges, useOnWindowVisible, useTabRead, useToolEdits, useWorktreeChanges } from "./useTabRead";

/**
 * The File tab (surfaces/files.ts): one file read with FilesystemService.ReadFile, under
 * header A. Text is code (line numbers, the line param marked and scrolled to). A file of a
 * preview kind (previews/: markdown and HTML rendered, an image, an SVG, a PDF's pages) shows
 * that way, with a switch of the kind's modes and Source (remembered per kind) when it has
 * more than one, and the kind's meta and actions; other
 * binaries, folders and missing paths get a placeholder; a missing path is first looked
 * for once in the checkout (findMissing: a model's path written from a subfolder or cut
 * short), and the file found is the tab's. Read again when the tab shows, on
 * Refresh, when the worktree changes and when the thread edits the file (useTabRead);
 * outside every project, whenever the file is written (useFileChanges). The pencil edits
 * a whole text file in place (stores/fileEdit.ts): while it does, the tab shows the
 * session's version, and those reads only go through observeRead, so none of them can
 * replace a draft. A thread can ask the user to edit it (`ask`, stores/fileRequest.ts): the
 * tab opens editing under a band, on an empty document where no file is. Text as code
 * (viewed or edited) and rendered markdown have a find (file.search, FileFind.tsx): a band
 * under the header that stays across the pencil.
 */
/** Each kind's read (PreviewKind.read), by the path's kind before reading; the code view reads whole. */
// "stream" is ReadFile too: a media file's read is its facts, no bytes; the player asks for its URL itself.
const READS: Record<PreviewRead, typeof readFile> = { whole: readFile, tail: readFileTail, stream: readFile };
const readOf = (p: string) => READS[previewKindOf(p, null)?.read ?? "whole"];

export function FileTab({ target }: { target: FileTarget }) {
  const { project, base, path, line, page, ask } = target;
  const wantsNew = ask !== undefined;
  const key = `${base}\u0000${path}`;
  // A path not found at base is looked for once in the checkout (findMissing); what that
  // found (or null) is read from then on, so a refresh does not search again.
  const found = useRef<{ key: string; path: string | null } | null>(null);
  const panelKey = usePanelKey();
  const tabId = fileTab(target).id;
  const editKey = fileEditKey(panelKey, tabId);
  const readTarget = async (signal: AbortSignal): Promise<FileReadView> => {
    // An edit session is bound to its file: no fallback, and the tab stays there after it.
    const pinned = editPath(editKey);
    if (pinned !== null) {
      found.current = { key, path: pinned };
      return readOf(pinned)(base, pinned, undefined, signal);
    }
    // A file to make is asked for by name: a namesake elsewhere is not it.
    const tried = found.current?.key === key && !wantsNew ? found.current : null;
    const first = await readOf(tried?.path ?? path)(base, tried?.path ?? path, undefined, signal);
    if (tried || !first.notFound || !project || wantsNew) return first;
    const alt = await findMissing(project, base, first.path || resolvePath(base, path), signal);
    found.current = { key, path: alt };
    if (alt === null) return first;
    const second = await readOf(alt)(base, alt, undefined, signal);
    return second.notFound ? first : second;
  };
  const read = useTabRead<FileReadView>(key, async (signal) => {
    const started = editClock();
    const view = await readTarget(signal);
    noteRead(view, started);
    return view;
  });
  const { reload, replace } = read;
  const later = useDebounced(reload);
  // Opened before its thread had a checkout: the project's file, not the thread's.
  const held = useFileHold(target, panelKey);
  const session = useFileEdit(editKey);
  const editing = session?.view != null;
  const dirty = session?.dirty === true;
  const file = session?.view ?? read.data;
  const abs = file?.path || resolvePath(base, path);
  useEffect(() => {
    if (read.data) observeRead(editKey, read.data);
  }, [editKey, read.data]);
  // What a save wrote is what the viewer shows when editing stops.
  const savedView = session?.view;
  useEffect(() => {
    if (savedView) replace(savedView);
  }, [savedView, replace]);
  useOnWindowVisible(later);
  useWorktreeChanges(project, project ? base : null, later);
  useToolEdits(project ? abs : "", later);
  // Outside every project (a thread's pages, the welcome page) no worktree reports a
  // write, so the file's stamp is watched instead (docs/notes/welcome-page.md).
  useFileChanges(project ? "" : abs, later);

  const name = fileName(abs) || abs;
  const rel = project ? relativeTo(abs, base) : null;
  const dir = rel !== null ? dirPart(rel) : tildify(dirPart(abs));
  const place = useMemo<FilePlace>(() => ({ project, dir: base || dirPart(abs), file: abs }), [project, base, abs]);

  // The read's kind (previews/registry.ts); before the first read, the extension's.
  const kind = useMemo(() => previewKindOf(abs, file ?? null), [abs, file]);
  const modes = useMemo(() => (kind && file ? previewModes(kind, file) : null), [kind, file]);
  const remembered = useCodeViewStore((s) => (kind ? s.preview[kind.id] : undefined));
  // Editing is on the source, for this tab only: the remembered choice stays for the viewer.
  const mode = !modes || editing ? SOURCE.id : pickMode(modes, remembered);
  const previewing = kind !== null && modes !== null && mode !== SOURCE.id;
  const text = file?.text ?? null;
  const lines = useMemo(() => (text === null ? 0 : lineCount(text)), [text]);
  // What the body says for row two's meta (an image's size, a PDF's pages), for the file and mode it showed.
  const bodyKey = `${abs}\u0000${kind?.id ?? ""}\u0000${mode}`;
  const [bodyMeta, setBodyMeta] = useState<{ key: string; meta: ReactNode } | null>(null);
  const onMeta = useCallback(
    (meta: ReactNode) => {
      setBodyMeta({ key: bodyKey, meta });
    },
    [bodyKey],
  );
  // Refresh presses: a rendered page loads again even when the file did not change.
  const [refreshes, setRefreshes] = useState(0);

  const editable = held === null && canEdit(file) && kind?.edit !== false;
  const startEditing = useCallback(() => {
    if (read.data) void startEdit(editKey, { panelKey, tabId, base }, read.data, { create: wantsNew });
  }, [read.data, editKey, panelKey, tabId, base, wantsNew]);
  // Asked to open editing (the tab's `edit` param), once per asking: the pencil can turn it
  // off, and a thread's next request turns it on again (a session already there stays).
  const asked = useRef<string | null>(null);
  const asking = ask?.id ?? "";
  const wantsEdit = target.edit === true;
  const creating = session?.creating === true;
  // A file to make has nothing to show yet: the document is on its way, not "File not found".
  const opening = held === null && wantsEdit && wantsNew && file?.notFound === true;
  useEffect(() => {
    if (!wantsEdit) asked.current = null;
    else if ((editable || opening) && asked.current !== asking) {
      asked.current = asking;
      startEditing();
    }
  }, [wantsEdit, asking, editable, opening, startEditing]);
  const leaveEdit = () => {
    stopEdit(editKey);
    reload();
  };
  // The mode switch, and a body's own way to another mode (PreviewBodyProps.onMode).
  const onMode = (m: string) => {
    if (!kind || (editing && m === SOURCE.id)) return;
    if (editing) leaveEdit();
    setPreviewMode(kind.id, m);
  };
  // The pencil puts the keyboard in the editor where the reader is, and the view stays put
  // (docs/notes/file-edit-keep-place.md); a tab coming back to a draft leaves it where it is.
  const onPencil = () => {
    if (dirty) return;
    if (editing) leaveEdit();
    else {
      focusNextEditor(editKey, readerPlaceOf(editKey));
      startEditing();
    }
  };
  const seed = session?.seed ?? "";
  const seedLines = useMemo(() => lineCount(seed), [seed]);
  const onDraft = useCallback((t: string) => {
    noteDraft(editKey, t);
    setFileFindDraft(editKey, t);
  }, [editKey]);
  const onOpening = useCallback((stateKey: string) => {
    editorOpening(editKey, stateKey);
  }, [editKey]);
  const onDetached = useCallback((stateKey: string) => {
    editorDetached(editKey, stateKey);
  }, [editKey]);
  const onReady = useCallback((editor: EditorHandle) => {
    noteEditor(editKey, editor);
  }, [editKey]);
  // Buttons that go disabled or away under the pointer would drop the keyboard on the body.
  const backToEditor = () => {
    focusEditor(editKey);
  };
  // The next document's editor takes the keyboard where the reader was, and the viewer is current if there is none.
  const startOver = (replaced: Promise<void>) => {
    focusNextEditor(editKey, readerPlaceOf(editKey));
    void replaced.then(reload);
  };
  const stateKey = editing ? session.stateKey : undefined;
  const revision = session?.revision ?? 0;
  // The line a thread pointed at stays marked until the user changes something.
  const mark = ask !== undefined && !dirty;
  const edit = useMemo<CodeFileEdit>(() => ({ active: stateKey !== undefined, stateKey, revision, onChange: onDraft, onOpening, onDetached, onReady, mark }), [stateKey, revision, onDraft, onOpening, onDetached, onReady, mark]);

  // What the find can search: the text as code, viewed or edited, or a preview whose kind
  // has text to search (rendered markdown; an HTML page is a frame of its own, an image no text).
  const searchable = file !== null && !opening && !file.notFound && !file.isDir && text !== null && (!previewing || kind.find === true);
  const findKey = searchable ? editKey : undefined;
  const findOpen = useFileFindOpen(editKey) && searchable;

  const meta = !file || creating ? null : file.notFound || file.isDir ? null : previewing ? (
    bodyMeta?.key === bodyKey ? bodyMeta.meta : kind.meta({ file, path: abs })
  ) : text === null ? (
    <>Binary · {formatSize(file.size)}</>
  ) : (
    <>
      {lines} {lines === 1 ? "line" : "lines"} · {formatSize(file.size)} · {kind?.source?.name ?? languageOf(abs)}
    </>
  );

  // Copy contents: a whole text read (a cut one, at its end or its start, would copy part of
  // the file). It copies the draft while editing, the kind's own text in a preview mode
  // that has one, else the text.
  const copyable = file !== null && !opening && !creating && text !== null && !file.truncated && file.truncatedStart !== true;
  const contents = copyable
    ? () => {
        if (session?.view) return draftText(session.stateKey) ?? session.seed;
        if (previewing && kind.copy) return kind.copy({ file, path: abs });
        return text;
      }
    : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="file-tab"
      data-path={abs}
      data-kind={kind?.id}
      data-mode={kind ? mode : undefined}
      data-loading={read.loading || undefined}
      data-file-find-box=""
      onFocus={() => {
        noteFileKeyboard(editKey);
      }}
    >
      <FileHeader
        icon={kind?.icon ?? fileIconOf(abs, file?.mime)}
        name={name}
        dir={dir}
        fullPath={abs}
        actions={<FileActions place={place} line={line} editor={kind?.editor !== false} onRefresh={() => { setRefreshes((n) => n + 1); reload(); }} contents={contents} extra={editable && !creating && <HeaderAction icon={Pencil} label="Edit" pressed={editing} testId="file-edit" onClick={onPencil} />} />}
      >
        {kind && modes && modes.length > 1 && !dirty && !creating && (
          <ModeSwitch
            options={modes.map((m) => ({ value: m.id, label: m.label }))}
            value={mode}
            onChange={onMode}
            label="Show as"
            testId="file-mode"
          />
        )}
        {previewing && file && kind.Controls && <kind.Controls file={file} path={abs} mode={mode} />}
        {editing && <EditStatus dirty={dirty} creating={creating} />}
        {meta && <HeaderMeta testId="file-meta">{meta}</HeaderMeta>}
        <span className="flex-1" />
        {text !== null && (!previewing || kind.wrap === true) && <WrapToggle />}
        {editing && (
          <EditButtons
            dirty={dirty}
            gone={session.conflict === "deleted"}
            busy={session.busy}
            chord={!ask}
            onDiscard={() => {
              startOver(discardDraft(editKey));
            }}
            onSave={() => {
              void saveFile(editKey).then(backToEditor);
            }}
          />
        )}
      </FileHeader>
      {findOpen && <FileFindBar findKey={editKey} />}
      {held && <NoticeBar testId="file-held">{held}</NoticeBar>}
      {ask && editing && (
        <FileRequestBand
          ask={ask}
          canTell={canTell(session, ask)}
          facts={fileFacts(session.where)}
          onTell={() => {
            void saveAndTell(editKey).then(backToEditor);
          }}
          onDismiss={() => {
            dismissAsk(editKey);
            backToEditor();
          }}
        />
      )}
      {session?.conflict && (
        <ConflictBand
          conflict={session.conflict}
          busy={session.busy}
          onReload={() => {
            startOver(reloadDraft(editKey));
          }}
          onOverwrite={() => {
            void saveFile(editKey, { force: true }).then(backToEditor);
          }}
        />
      )}
      {session?.failure && <EditFailedBand message={session.failure} />}
      {file && read.error && <NoticeBar testId="file-refresh-error">Refresh failed: {read.error}</NoticeBar>}
      {file?.truncated && text !== null && <NoticeBar testId="file-truncated">{truncatedNotice(file.size)}</NoticeBar>}
      {file?.truncatedStart && text !== null && <NoticeBar testId="file-truncated-start">{tailNotice(file.size)}</NoticeBar>}
      <FileBody file={opening ? null : file} error={read.error} reload={reload} refreshes={refreshes} place={place} name={name} abs={abs} text={editing ? seed : text} lines={editing ? seedLines : lines} line={line} page={page} preview={previewing ? kind : null} lang={kind?.source?.lang} mode={mode} edit={edit} findKey={findKey} onMeta={onMeta} onMode={onMode} />
    </div>
  );
}

function FileBody({
  file,
  error,
  reload,
  refreshes,
  place,
  name,
  abs,
  text,
  lines,
  line,
  page,
  preview,
  lang,
  mode,
  edit,
  findKey,
  onMeta,
  onMode,
}: {
  file: FileReadView | null;
  error: string | null;
  reload: () => void;
  refreshes: number;
  place: FilePlace;
  name: string;
  abs: string;
  text: string | null;
  lines: number;
  line: number | undefined;
  page: FileTarget["page"];
  /** The kind whose preview mode is on; null for the code view. */
  preview: PreviewKind | null;
  /** Source's language when the kind gives one. */
  lang: SupportedLanguages | undefined;
  mode: string;
  edit: CodeFileEdit;
  findKey: string | undefined;
  onMeta: PreviewBodyProps["onMeta"];
  onMode: PreviewBodyProps["onMode"];
}) {
  const retry = (
    <Button variant="outline" size="sm" onClick={reload} data-testid="file-retry">
      Retry
    </Button>
  );
  const editor = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        openInEditor(place);
      }}
    >
      <SquareArrowOutUpRight aria-hidden />
      Open in editor
    </Button>
  );
  const reveal = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        revealInFinder(place);
      }}
    >
      <FinderIcon aria-hidden />
      Open in Finder
    </Button>
  );
  if (!file && error)
    return (
      <FileEmptyState icon={TriangleAlert} heading="Cannot read the file" detail={error} testId="file-error">
        {retry}
      </FileEmptyState>
    );
  if (!file) return <FileLoading />;
  if (file.notFound)
    return (
      <FileEmptyState icon={FileQuestion} heading="File not found" detail={tildify(abs)} testId="file-not-found">
        {retry}
      </FileEmptyState>
    );
  if (file.isDir)
    return (
      <FileEmptyState icon={Folder} heading="This is a folder" detail={tildify(abs)} testId="file-folder">
        {reveal}
      </FileEmptyState>
    );
  if (preview) {
    // An image or PDF over the read cap came back cut short: neither the webview nor pdf.js can show part of one.
    if (file.truncated && preview.tooLarge !== undefined)
      return (
        <FileEmptyState icon={preview.icon ?? fileIconOf(abs, file.mime)} heading={tooLargeHeading(preview.tooLarge, file.size)} detail={tildify(abs)} testId={`file-${preview.id}-too-large`}>
          {preview.editor !== false && editor}
          {reveal}
        </FileEmptyState>
      );
    return (
      <Suspense fallback={<FileLoading />}>
        <preview.Body file={file} path={abs} mode={mode} name={name} place={place} page={page} reloads={refreshes} findKey={findKey} onMeta={onMeta} onMode={onMode} />
      </Suspense>
    );
  }
  if (text === null)
    return (
      <FileEmptyState icon={FileX} heading={`Binary file · ${formatSize(file.size)}`} detail={tildify(abs)} testId="file-binary">
        {editor}
        {reveal}
      </FileEmptyState>
    );
  return <CodeBody name={name} text={text} lang={lang} lines={lines} line={line} edit={edit} findKey={findKey} />;
}
