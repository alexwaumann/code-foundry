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
