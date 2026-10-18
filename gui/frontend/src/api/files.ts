import { FilesystemService, type ReadFileResponse } from "@/gen/codefoundry/v1/filesystem_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/**
 * FilesystemService.ReadFile as the File tab shows it (docs/notes/file-viewer-3-tabs.md).
 * Text is decoded as UTF-8 (invalid bytes become U+FFFD) when the daemon calls the file
 * text; an image keeps its bytes for an object URL; any other binary keeps neither.
 */
export interface FileReadView {
  /** Absolute, cleaned path as asked for (before following symlinks). */
  path: string;
  /** Size of the whole file in bytes (a directory's own size for a folder). */
  size: number;
  /** Only the first MiB came back. */
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
}

const utf8 = new TextDecoder("utf-8");

/** Whether a MIME type is an image the webview can show (`image/svg+xml` included). */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function toFileReadView(r: ReadFileResponse): FileReadView {
  const image = isImageMime(r.mimeType);
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
    image: image && !r.notFound && !r.isDir ? r.contents : null,
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
    return toFileReadView(await c.readFile({ baseDir, path, maxBytes: 0n }, { signal }));
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
