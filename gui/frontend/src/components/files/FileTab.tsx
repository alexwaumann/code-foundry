import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileImage, FileQuestion, FileText, FileX, Folder, Pencil, SquareArrowOutUpRight, TriangleAlert, type LucideIcon } from "lucide-react";
import { canEdit, readFile, type FileReadView } from "@/api/files";
import type { CodeFileEdit } from "@/components/code/CodeFile";
import { FinderIcon } from "@/components/icons/AppIcon";
import { usePanelKey } from "@/components/panel/panelKeyContext";
import { ago } from "@/components/pr/model";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { dirPart, extOf, fileName, relativeTo, resolvePath } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { setPreviewMode, useCodeViewStore, type PreviewMode } from "@/stores/codeView";
import { discardDraft, editClock, editorDetached, fileEditKey, noteDraft, noteRead, observeRead, reloadDraft, saveFile, startEdit, stopEdit, useFileEdit } from "@/stores/fileEdit";
import { fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { CodeBody } from "./CodeBody";
import { openInEditor, revealInFinder, type FilePlace } from "./fileActions";
import { ConflictBand, EditButtons, EditStatus, SaveFailedBand } from "./FileEditBar";
import { FileActions, FileHeader, HeaderAction, HeaderMeta, ModeSwitch, WrapToggle } from "./FileHeader";
import { findMissing } from "./findMissing";
import { fileIconOf, formatSize, languageOf, lineCount, pdfMeta, previewKindOf, tooLargeHeading, truncatedNotice } from "./fileKind";
import { HtmlPreview } from "./HtmlPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";
import { FileEmptyState, FileLoading, NoticeBar } from "./states";
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
 * replace a draft.
 */
export function FileTab({ target }: { target: FileTarget }) {
  const { project, base, path, line, page } = target;
  const key = `${base}\u0000${path}`;
  // A path not found at base is looked for once in the checkout (findMissing); what that
  // found (or null) is read from then on, so a refresh does not search again.
  const found = useRef<{ key: string; path: string | null } | null>(null);
  const read = useTabRead<FileReadView>(key, async (signal) => {
    const started = editClock();
    const tried = found.current?.key === key ? found.current : null;
    const first = await readFile(base, tried?.path ?? path, undefined, signal);
    noteRead(first, started);
    if (tried || !first.notFound || !project) return first;
    const alt = await findMissing(project, base, first.path || resolvePath(base, path), signal);
    found.current = { key, path: alt };
    if (alt === null) return first;
    const second = await readFile(base, alt, undefined, signal);
    noteRead(second, started);
    return second.notFound ? first : second;
  });
  const { reload, replace } = read;
  const later = useDebounced(reload);
  const panelKey = usePanelKey();
  const tabId = fileTab(target).id;
  const editKey = fileEditKey(panelKey, tabId);
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
  const onSize = useCallback((w: number, h: number) => {
    setDims({ w, h });
  }, []);
  const [pages, setPages] = useState<number | null>(null);

  const editable = canEdit(file);
  const startEditing = useCallback(() => {
    if (read.data) void startEdit(editKey, { panelKey, tabId, base }, read.data);
  }, [read.data, editKey, panelKey, tabId, base]);
  // Asked to open editing (the tab's `edit` param), once per asking: the pencil can turn it off.
  const asked = useRef(false);
  const wantsEdit = target.edit === true;
  useEffect(() => {
    if (!wantsEdit) asked.current = false;
    else if (editable && !asked.current) {
      asked.current = true;
      startEditing();
    }
  }, [wantsEdit, editable, startEditing]);
  // The pencil puts the keyboard in the editor; a tab coming back to a draft leaves it where it is.
  const focusEditor = useRef(false);
  const leaveEdit = () => {
    stopEdit(editKey);
    reload();
  };
  const onPencil = () => {
    if (dirty) return;
    if (editing) leaveEdit();
    else {
      focusEditor.current = true;
      startEditing();
    }
  };
  const seed = session?.seed ?? "";
  const seedLines = useMemo(() => lineCount(seed), [seed]);
  const onDraft = useCallback((t: string) => {
    noteDraft(editKey, t);
  }, [editKey]);
  const onDetached = useCallback((stateKey: string) => {
    editorDetached(editKey, stateKey);
  }, [editKey]);
  const onReady = useCallback((focus: () => void) => {
    if (focusEditor.current) focus();
    focusEditor.current = false;
  }, []);
  const stateKey = editing ? session.stateKey : undefined;
  const revision = session?.revision ?? 0;
  const edit = useMemo<CodeFileEdit>(() => ({ active: stateKey !== undefined, stateKey, revision, onChange: onDraft, onDetached, onReady }), [stateKey, revision, onDraft, onDetached, onReady]);

  const meta = !file ? null : file.notFound || file.isDir ? null : file.pdf ? (
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
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-tab" data-path={abs} data-mode={kind ? mode : undefined} data-loading={read.loading || undefined}>
      <FileHeader
        icon={fileIconOf(abs, file?.mime)}
        name={name}
        dir={dir}
        fullPath={abs}
        actions={<FileActions place={place} line={line} onRefresh={reload} extra={editable && <HeaderAction icon={Pencil} label="Edit" pressed={editing} testId="file-edit" onClick={onPencil} />} />}
      >
        {kind && text !== null && !dirty && (
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
        {editing && <EditStatus dirty={dirty} />}
        {meta && <HeaderMeta testId="file-meta">{meta}</HeaderMeta>}
        <span className="flex-1" />
        {text !== null && !rendered && <WrapToggle />}
        {editing && (
          <EditButtons
            dirty={dirty}
            saving={session.saving}
            onDiscard={() => {
              void discardDraft(editKey).then(reload);
            }}
            onSave={() => {
              void saveFile(editKey);
            }}
          />
        )}
      </FileHeader>
      {session?.conflict && (
        <ConflictBand
          conflict={session.conflict}
          onReload={() => {
            void reloadDraft(editKey).then(reload);
          }}
          onOverwrite={() => {
            void saveFile(editKey, { force: true });
          }}
        />
      )}
      {session?.failure && <SaveFailedBand message={session.failure} />}
      {file && read.error && <NoticeBar testId="file-refresh-error">Refresh failed: {read.error}</NoticeBar>}
      {file?.truncated && text !== null && <NoticeBar testId="file-truncated">{truncatedNotice(file.size)}</NoticeBar>}
      <FileBody file={file} error={read.error} reload={reload} place={place} name={name} abs={abs} text={editing ? seed : text} lines={editing ? seedLines : lines} line={line} page={page} rendered={rendered ? kind : null} edit={edit} onSize={onSize} onPages={setPages} />
    </div>
  );
}

function FileBody({
  file,
  error,
  reload,
  place,
  name,
  abs,
  text,
  lines,
  line,
  page,
  rendered,
  edit,
  onSize,
  onPages,
}: {
  file: FileReadView | null;
  error: string | null;
  reload: () => void;
  place: FilePlace;
  name: string;
  abs: string;
  text: string | null;
  lines: number;
  line: number | undefined;
  page: FileTarget["page"];
  rendered: "markdown" | "html" | null;
  edit: CodeFileEdit;
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
  if (rendered === "markdown") return <MarkdownPreview text={text} dir={dirPart(abs)} project={place.project} base={place.dir} />;
  if (rendered === "html") return <HtmlPreview path={abs} text={text} name={name} page={page} />;
  return <CodeBody name={name} text={text} lines={lines} line={line} edit={edit} />;
}
