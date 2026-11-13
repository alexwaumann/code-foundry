import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileImage, FileQuestion, FileText, FileX, Folder, Pencil, SquareArrowOutUpRight, TriangleAlert, type LucideIcon } from "lucide-react";
import { canEdit, readFile, type FileReadView } from "@/api/files";
import type { CodeFileEdit } from "@/components/code/CodeFile";
import type { EditorHandle } from "@/lib/codeEditor";
import { FinderIcon } from "@/components/icons/AppIcon";
import { usePanelKey } from "@/shell/panelKeyContext";
import { ago } from "@/components/pr/model";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { dirPart, extOf, fileName, relativeTo, resolvePath } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { setPreviewMode, useCodeViewStore, type PreviewMode } from "@/stores/codeView";
import { discardDraft, editClock, editorDetached, editorOpening, editPath, fileEditKey, focusEditor, focusNextEditor, noteDraft, noteEditor, noteRead, observeRead, reloadDraft, saveFile, startEdit, stopEdit, useFileEdit } from "@/stores/fileEdit";
import { noteFileKeyboard, setFileFindDraft, useFileFindOpen } from "@/stores/fileFind";
import { canTell, dismissAsk, fileFacts, saveAndTell } from "@/stores/fileRequest";
import { fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { CodeBody } from "./CodeBody";
import { openInEditor, revealInFinder, type FilePlace } from "./fileActions";
import { ConflictBand, EditButtons, EditFailedBand, EditStatus } from "./FileEditBar";
import { FileRequestBand } from "./FileRequestBand";
import { FileActions, FileHeader, HeaderAction, HeaderMeta, ModeSwitch, WrapToggle } from "./FileHeader";
import { findMissing } from "./findMissing";
import { fileIconOf, formatSize, languageOf, lineCount, pdfMeta, previewKindOf, tooLargeHeading, truncatedNotice } from "./fileKind";
import { HtmlPreview } from "./HtmlPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";
import { FileFindBar } from "./FileFind";
import { FileEmptyState, FileLoading, NoticeBar } from "./states";
import { useFileHold } from "./useFileHold";
import { useDebounced, useFileChanges, useOnWindowVisible, useTabRead, useToolEdits, useWorktreeChanges } from "./useTabRead";

const MODES = [
  { value: "rendered", label: "Rendered" },
  { value: "source", label: "Source" },
] as const satisfies readonly { value: PreviewMode; label: string }[];


/** "saved 2m ago" for a rendered file's meta. */
function SavedAgo({ ms }: { ms: number | null }) {
  const now = useNow(30_000);
  return ms === null ? null : <>saved {ago(ms, now)}</>;
}

/**
 * The File tab (surfaces/files.ts): one file read with FilesystemService.ReadFile, under
 * header A. Text is code (line numbers, the line param marked and scrolled to); markdown
 * and HTML also render (Rendered | Source, remembered per kind); images show inline and
 * PDFs as their pages (an image or PDF too large to come back whole says so); other
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
      return readFile(base, pinned, undefined, signal);
    }
    // A file to make is asked for by name: a namesake elsewhere is not it.
    const tried = found.current?.key === key && !wantsNew ? found.current : null;
    const first = await readFile(base, tried?.path ?? path, undefined, signal);
    if (tried || !first.notFound || !project || wantsNew) return first;
    const alt = await findMissing(project, base, first.path || resolvePath(base, path), signal);
    found.current = { key, path: alt };
    if (alt === null) return first;
    const second = await readFile(base, alt, undefined, signal);
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

  const kind = previewKindOf(abs);
  const storedMode = useCodeViewStore((s) => (kind ? s.preview[kind] : "source"));
  // Editing is on the source, for this tab only: the remembered choice stays for the viewer.
  const mode = editing ? "source" : storedMode;
  const text = file?.text ?? null;
  const lines = useMemo(() => (text === null ? 0 : lineCount(text)), [text]);
  const rendered = kind !== null && text !== null && mode === "rendered";
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Refresh presses: a rendered page loads again even when the file did not change.
  const [refreshes, setRefreshes] = useState(0);
  const onSize = useCallback((w: number, h: number) => {
    setDims({ w, h });
  }, []);
  const [pages, setPages] = useState<number | null>(null);

  const editable = held === null && canEdit(file);
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
  // The pencil puts the keyboard in the editor; a tab coming back to a draft leaves it where it is.
  const onPencil = () => {
    if (dirty) return;
    if (editing) leaveEdit();
    else {
      focusNextEditor(editKey);
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
  // The next document's editor takes the keyboard, and the viewer is current if there is none.
  const startOver = (replaced: Promise<void>) => {
    focusNextEditor(editKey);
    void replaced.then(reload);
  };
  const stateKey = editing ? session.stateKey : undefined;
  const revision = session?.revision ?? 0;
  // The line a thread pointed at stays marked until the user changes something.
  const mark = ask !== undefined && !dirty;
  const edit = useMemo<CodeFileEdit>(() => ({ active: stateKey !== undefined, stateKey, revision, onChange: onDraft, onOpening, onDetached, onReady, mark }), [stateKey, revision, onDraft, onOpening, onDetached, onReady, mark]);

  // What the find can search: the text as code, viewed or edited, or rendered markdown (an
  // HTML page is a frame of its own, an image or a PDF has no text here).
  const searchable = file !== null && !opening && !file.notFound && !file.isDir && text !== null && !(rendered && kind === "html");
  const findKey = searchable ? editKey : undefined;
  const findOpen = useFileFindOpen(editKey) && searchable;

  const meta = !file || creating ? null : file.notFound || file.isDir ? null : file.pdf ? (
    pdfMeta(file.size, file.truncated ? null : pages)
  ) : file.image ? (
    <>
      {dims && `${String(dims.w)} × ${String(dims.h)} · `}
      {formatSize(file.size)} · {extOf(abs).toUpperCase() || file.mime}
    </>
  ) : text === null ? (
    <>Binary · {formatSize(file.size)}</>
  ) : rendered ? (
    <>
      <SavedAgo ms={file.modifiedAtMs} />
      {file.modifiedAtMs !== null && " · "}
      {formatSize(file.size)}
    </>
  ) : (
    <>
      {lines} {lines === 1 ? "line" : "lines"} · {formatSize(file.size)} · {languageOf(abs)}
    </>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="file-tab"
      data-path={abs}
      data-mode={kind ? mode : undefined}
      data-loading={read.loading || undefined}
      data-file-find-box=""
      onFocus={() => {
        noteFileKeyboard(editKey);
      }}
    >
      <FileHeader
        icon={fileIconOf(abs, file?.mime)}
        name={name}
        dir={dir}
        fullPath={abs}
        actions={<FileActions place={place} line={line} onRefresh={() => { setRefreshes((n) => n + 1); reload(); }} extra={editable && !creating && <HeaderAction icon={Pencil} label="Edit" pressed={editing} testId="file-edit" onClick={onPencil} />} />}
      >
        {kind && text !== null && !dirty && !creating && (
          <ModeSwitch
            options={MODES}
            value={mode}
            onChange={(m) => {
              if (editing && m === "source") return;
              if (editing) leaveEdit();
              setPreviewMode(kind, m);
            }}
            label="Show as"
            testId="file-mode"
          />
        )}
        {editing && <EditStatus dirty={dirty} creating={creating} />}
        {meta && <HeaderMeta testId="file-meta">{meta}</HeaderMeta>}
        <span className="flex-1" />
        {text !== null && !rendered && <WrapToggle />}
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
      <FileBody file={opening ? null : file} error={read.error} reload={reload} refreshes={refreshes} place={place} name={name} abs={abs} text={editing ? seed : text} lines={editing ? seedLines : lines} line={line} page={page} rendered={rendered ? kind : null} edit={edit} findKey={findKey} onSize={onSize} onPages={setPages} />
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
  rendered,
  edit,
  findKey,
  onSize,
  onPages,
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
  rendered: "markdown" | "html" | null;
  edit: CodeFileEdit;
  findKey: string | undefined;
  onSize: (w: number, h: number) => void;
  onPages: (pages: number) => void;
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
  // An image or PDF over the read cap came back cut short: neither the webview nor pdf.js can show part of one.
  const tooLarge = (icon: LucideIcon, kind: "Image" | "PDF", testId: string) => (
    <FileEmptyState icon={icon} heading={tooLargeHeading(kind, file.size)} detail={tildify(abs)} testId={testId}>
      {editor}
      {reveal}
    </FileEmptyState>
  );
  if (file.image) return file.truncated ? tooLarge(FileImage, "Image", "file-image-too-large") : <ImagePreview bytes={file.image} mime={file.mime} name={name} onSize={onSize} />;
  if (file.pdf) return file.truncated ? tooLarge(FileText, "PDF", "file-pdf-too-large") : <PdfPreview bytes={file.pdf} onPages={onPages} />;
  if (text === null)
    return (
      <FileEmptyState icon={FileX} heading={`Binary file · ${formatSize(file.size)}`} detail={tildify(abs)} testId="file-binary">
        {editor}
        {reveal}
      </FileEmptyState>
    );
  if (rendered === "markdown") return <MarkdownPreview text={text} dir={dirPart(abs)} project={place.project} base={place.dir} findKey={findKey} />;
  if (rendered === "html") return <HtmlPreview path={abs} text={text} name={name} page={page} reloads={refreshes} />;
  return <CodeBody name={name} text={text} lines={lines} line={line} edit={edit} findKey={findKey} />;
}
