import { useCallback, useMemo, useRef, useState } from "react";
import { FileImage, FileQuestion, FileText, FileX, Folder, FolderSearch, SquareArrowOutUpRight, TriangleAlert, type LucideIcon } from "lucide-react";
import { readFile, type FileReadView } from "@/api/files";
import { ago } from "@/components/pr/model";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { dirPart, extOf, fileName, relativeTo, resolvePath } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { setPreviewMode, useCodeViewStore, type PreviewMode } from "@/stores/codeView";
import type { FileTarget } from "@/surfaces/fileTarget";
import { CodeBody } from "./CodeBody";
import { openInEditor, revealInFinder, type FilePlace } from "./fileActions";
import { FileActions, FileHeader, HeaderMeta, ModeSwitch, WrapToggle } from "./FileHeader";
import { findMissing } from "./findMissing";
import { fileIconOf, formatSize, languageOf, lineCount, pdfMeta, previewKindOf, tooLargeHeading, truncatedNotice } from "./fileKind";
import { HtmlPreview } from "./HtmlPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";
import { FileEmptyState, FileLoading, NoticeBar } from "./states";
import { useDebounced, useOnWindowVisible, useTabRead, useToolEdits, useWorktreeChanges } from "./useTabRead";

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
 * Refresh, when the worktree changes and when the thread edits the file (useTabRead).
 */
export function FileTab({ target }: { target: FileTarget }) {
  const { project, base, path, line } = target;
  const key = `${base}\u0000${path}`;
  // A path not found at base is looked for once in the checkout (findMissing); what that
  // found (or null) is read from then on, so a refresh does not search again.
  const found = useRef<{ key: string; path: string | null } | null>(null);
  const read = useTabRead<FileReadView>(key, async (signal) => {
    const tried = found.current?.key === key ? found.current : null;
    const first = await readFile(base, tried?.path ?? path, undefined, signal);
    if (tried || !first.notFound || !project) return first;
    const alt = await findMissing(project, base, first.path || resolvePath(base, path), signal);
    found.current = { key, path: alt };
    if (alt === null) return first;
    const second = await readFile(base, alt, undefined, signal);
    return second.notFound ? first : second;
  });
  const { reload } = read;
  const later = useDebounced(reload);
  const file = read.data;
  const abs = file?.path || resolvePath(base, path);
  useOnWindowVisible(later);
  useWorktreeChanges(project, project ? base : null, later);
  useToolEdits(abs, later);

  const name = fileName(abs) || abs;
  const rel = project ? relativeTo(abs, base) : null;
  const dir = rel !== null ? dirPart(rel) : tildify(dirPart(abs));
  const place = useMemo<FilePlace>(() => ({ project, dir: base || dirPart(abs), file: abs }), [project, base, abs]);

  const kind = previewKindOf(abs);
  const mode = useCodeViewStore((s) => (kind ? s.preview[kind] : "source"));
  const text = file?.text ?? null;
  const lines = useMemo(() => (text === null ? 0 : lineCount(text)), [text]);
  const rendered = kind !== null && text !== null && mode === "rendered";
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const onSize = useCallback((w: number, h: number) => {
    setDims({ w, h });
  }, []);
  const [pages, setPages] = useState<number | null>(null);

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
      <FileHeader icon={fileIconOf(abs, file?.mime)} name={name} dir={dir} fullPath={abs} actions={<FileActions place={place} line={line} onRefresh={reload} />}>
        {kind && text !== null && (
          <ModeSwitch
            options={MODES}
            value={mode}
            onChange={(m) => {
              setPreviewMode(kind, m);
            }}
            label="Show as"
            testId="file-mode"
          />
        )}
        {meta && <HeaderMeta testId="file-meta">{meta}</HeaderMeta>}
        <span className="flex-1" />
        {text !== null && !rendered && <WrapToggle />}
      </FileHeader>
      {file && read.error && <NoticeBar testId="file-refresh-error">Refresh failed: {read.error}</NoticeBar>}
      {file?.truncated && text !== null && <NoticeBar testId="file-truncated">{truncatedNotice(file.size)}</NoticeBar>}
      <FileBody file={file} error={read.error} reload={reload} place={place} name={name} abs={abs} text={text} lines={lines} line={line} rendered={rendered ? kind : null} onSize={onSize} onPages={setPages} />
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
  rendered,
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
  rendered: "markdown" | "html" | null;
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
      <FolderSearch aria-hidden />
      Reveal in Finder
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
  if (rendered === "html") return <HtmlPreview path={abs} text={text} name={name} />;
  return <CodeBody name={name} text={text} lines={lines} line={line} />;
}
