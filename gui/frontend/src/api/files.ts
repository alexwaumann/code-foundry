import { FilesystemService, type ReadFileResponse } from "@/gen/codefoundry/v1/filesystem_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/**
 * FilesystemService.ReadFile as the File tab shows it (docs/notes/file-viewer-3-tabs.md).
 * Text is decoded as UTF-8 (invalid bytes become U+FFFD) when the daemon calls the file
 * text; an image or a PDF keeps its bytes (an object URL, pdf.js); any other binary keeps
 * neither.
 */
export interface FileReadView {
  /** Absolute, cleaned path as asked for (before following symlinks). */
  path: string;
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
  /** The decoded contents of a text file; null for binary, folders and missing files. */
  text: string | null;
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

export const PDF_MIME = "application/pdf";

const utf8 = new TextDecoder("utf-8");

/** Whether a MIME type is an image the webview can show (`image/svg+xml` included). */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function toFileReadView(r: ReadFileResponse): FileReadView {
  const image = isImageMime(r.mimeType);
  const pdf = r.mimeType === PDF_MIME;
  const present = !r.notFound && !r.isDir;
  const text = !r.binary && !r.notFound && !r.isDir ? utf8.decode(r.contents) : null;
  return {
    path: r.resolvedPath,
    size: Number(r.size),
    truncated: r.truncated,
    binary: r.binary,
    mime: r.mimeType,
    modifiedAtMs: r.modifiedAt > 0n ? Number(r.modifiedAt) : null,
    notFound: r.notFound,
    isDir: r.isDir,
    text,
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
