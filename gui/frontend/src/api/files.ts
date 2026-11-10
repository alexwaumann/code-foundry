import { FilesystemService, type ReadFileResponse } from "@/gen/codefoundry/v1/filesystem_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";
import { PDF_MIME_TYPE } from "./threads";

/**
 * FilesystemService.ReadFile as the File tab shows it (docs/notes/file-viewer-3-tabs.md).
 * Text is decoded as UTF-8 (invalid bytes become U+FFFD) when the daemon calls the file
 * text; an image or a PDF keeps its bytes (an object URL, pdf.js); any other binary keeps
 * neither.
 */
export interface FileReadView {
  /** Absolute, cleaned path as asked for (before following symlinks). */
  path: string;
  /** Where a write lands, symlinks followed: of a missing file, where it would be; "" when not known. */
  realPath: string;
  /** The real file's permission bits; 0 for a missing file. */
  mode: number;
  /** Size of the whole file in bytes (a directory's own size for a folder). */
  size: number;
  /** Only part came back: the first MiB of a text file, the first READ_MAX_BYTES of any other. */
  truncated: boolean;
  binary: boolean;
  /** "text/markdown", "image/png", "text/plain; charset=utf-8", … ("" when not found). */
  mime: string;
  modifiedAtMs: number | null;
  notFound: boolean;
  isDir: boolean;
  /** The file is in a temp folder, or otherwise outside home: it can be read and not saved. */
  outsideHome: boolean;
  /** The decoded contents of a text file; null for binary, folders and missing files. */
  text: string | null;
  /**
   * `text` is the bytes exactly (valid UTF-8, no byte order mark), so writing it back
   * changes only what was edited. False for a file with invalid bytes or a BOM, whose text
   * lost them to the decode, and for anything without text.
   */
  lossless: boolean;
  /** The bytes of an image (mime image/*); null otherwise. */
  image: Uint8Array | null;
  /** The bytes of a PDF (mime application/pdf); null otherwise. */
  pdf: Uint8Array | null;
}

/**
 * How much readFile asks for: 32 MiB, so an image or a PDF up to that size comes back
 * whole. Text is capped at 1 MiB by the daemon whatever we ask, and a daemon older than the
 * larger cap clamps every read to 1 MiB, so there the File tab behaves as it did (a larger
 * image or PDF is truncated and shown as too large).
 */
export const READ_MAX_BYTES = 32 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = 0xfeff;

/** A text file's bytes as the tab shows them, and whether they survive the round trip (FileReadView.lossless). */
function decodeText(bytes: Uint8Array): { text: string; lossless: boolean } {
  try {
    const text = strictUtf8.decode(bytes);
    return text.charCodeAt(0) === BOM ? { text: text.slice(1), lossless: false } : { text, lossless: true };
  } catch {
    return { text: utf8.decode(bytes), lossless: false };
  }
}

/** What a tab edits where no file is yet: an empty text document at `path`, nothing on disk behind it. */
export function blankFile(path: string, realPath = ""): FileReadView {
  return { path, realPath, mode: 0, size: 0, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: null, notFound: false, isDir: false, outsideHome: false, text: "", lossless: true, image: null, pdf: null };
}

/** Whether a MIME type is an image the webview can show (`image/svg+xml` included). */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/**
 * Whether the File tab offers to edit a read: whole text whose bytes survive the round
 * trip. A truncated read would save without the rest of the file, and the daemon does not
 * know a read was truncated; a file with invalid UTF-8 or a BOM would lose those bytes.
 * Images (an SVG is text) show as pictures, so there is no code to edit. A file outside home
 * (a temp folder's) is only for reading: the daemon would refuse the save.
 */
export function canEdit(file: FileReadView | null): boolean {
  return file !== null && file.text !== null && file.lossless && !file.truncated && !file.binary && !file.notFound && !file.isDir && !file.outsideHome && file.image === null && file.pdf === null;
}

export function toFileReadView(r: ReadFileResponse): FileReadView {
  const image = isImageMime(r.mimeType);
  const pdf = r.mimeType === PDF_MIME_TYPE;
  const present = !r.notFound && !r.isDir;
  const decoded = !r.binary && !r.notFound && !r.isDir ? decodeText(r.contents) : null;
  return {
    path: r.resolvedPath,
    realPath: r.realPath,
    mode: r.mode,
    size: Number(r.size),
    truncated: r.truncated,
    binary: r.binary,
    mime: r.mimeType,
    modifiedAtMs: r.modifiedAt > 0n ? Number(r.modifiedAt) : null,
    notFound: r.notFound,
    isDir: r.isDir,
    outsideHome: r.outsideHome,
    text: decoded?.text ?? null,
    lossless: decoded?.lossless ?? false,
    image: image && present ? r.contents : null,
    pdf: pdf && present ? r.contents : null,
  };
}

/**
 * Reads a file under home: `path` absolute, "~/…", or relative to `baseDir` (absolute).
 * A path outside home is an InvalidArgument error; a missing path comes back `notFound`.
 * A daemon older than the RPC fails with OutdatedDaemonError.
 */
export async function readFile(baseDir: string, path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<FileReadView> {
  const c = await conn.client(FilesystemService);
  try {
    return toFileReadView(await c.readFile({ baseDir, path, maxBytes: BigInt(READ_MAX_BYTES) }, { signal }));
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/** Which version of a file a write replaces: what its read reported. */
export interface FileVersion {
  size: number;
  modifiedAtMs: number | null;
}

/** One version of a file as a string, for telling it from another. */
export function versionStamp(v: FileVersion): string {
  return `${String(v.size)}:${String(v.modifiedAtMs)}`;
}

/** FilesystemService.WriteFile's answer. A conflict wrote nothing. */
export interface FileWriteView extends FileVersion {
  /** Absolute, cleaned path as asked for (before following symlinks). */
  path: string;
  /** The file is not the version asked for; size and time are of what is there. */
  conflict: boolean;
  /** With conflict: nothing is at the path. */
  notFound: boolean;
}

/**
 * Replaces a file's contents with `text`, as UTF-8, if it is still `version` (`force`
 * writes whatever is there, and makes a file that went; `create` makes a file where none
 * is, at 0600, and never replaces one that appeared). `path` as for readFile. A conflict
 * is an answer, not an error. A refusal is an error with a message fit to show:
 * FailedPrecondition (read-only, locked, an unwritable folder), ResourceExhausted (disk
 * full), PermissionDenied (macOS privacy), InvalidArgument (over 1 MiB, a config home
 * file). A daemon older than the RPC fails with OutdatedDaemonError.
 */
export async function writeFile(baseDir: string, path: string, text: string, version: FileVersion, opts: { force?: boolean; create?: boolean } = {}, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<FileWriteView> {
  const c = await conn.client(FilesystemService);
  try {
    const r = await c.writeFile(
      { baseDir, path, contents: encoder.encode(text), modifiedAt: BigInt(version.modifiedAtMs ?? 0), size: BigInt(version.size), force: opts.force ?? false, create: opts.create ?? false },
      { signal },
    );
    return { path: r.resolvedPath, size: Number(r.size), modifiedAtMs: r.modifiedAt > 0n ? Number(r.modifiedAt) : null, conflict: r.conflict, notFound: r.notFound };
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/**
 * What tells one version of a file from the next without reading it: "<size>:<mtime ms>",
 * or "" when nothing is there. Any write moves the time (an editor's save, `cp` over the
 * file, `touch`), so a write in between changes the stamp.
 */
export type FileStamp = string;

/** The file's stamp (FileStamp): ReadFile for one byte, so only its head is read. */
export async function statFile(baseDir: string, path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<FileStamp> {
  const c = await conn.client(FilesystemService);
  try {
    const r = await c.readFile({ baseDir, path, maxBytes: 1n }, { signal });
    return r.notFound ? "" : `${String(r.size)}:${String(r.modifiedAt)}`;
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/** Where the HTML preview loads a file from (FilesystemService.PreviewFile). */
export interface FilePreview {
  /** Absolute URL on the daemon's loopback listener; no bearer token needed (the grant is in the path). */
  url: string;
  /** Absolute directory the page may load files from: its checkout, else its directory; the file itself when singleFile. */
  scope: string;
  /** The page may load only itself: its directory is home or otherwise too broad to hand it. */
  singleFile: boolean;
}

/**
 * Grants the HTML preview a URL for `path` (as for readFile) and joins it to the daemon's
 * base URL. A missing file is NotFound; a directory, a path outside home or a file in a
 * protected folder (Code Foundry's own data, ~/.ssh, ~/Library) is InvalidArgument. A daemon older than the RPC fails with OutdatedDaemonError.
 */
export async function previewFile(baseDir: string, path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<FilePreview> {
  const c = await conn.client(FilesystemService);
  try {
    const r = await c.previewFile({ baseDir, path }, { signal });
    const { baseUrl } = await conn.resolveEndpoint();
    return { url: new URL(r.url, baseUrl).toString(), scope: r.scope, singleFile: r.singleFile };
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
