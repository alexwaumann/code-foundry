/**
 * The mock daemon's media route and log fixtures (docs/notes/file-previews-2-daemon.md): the
 * daemon's GET /media/<grant>/<name> (internal/preview/media.go) answers Range requests as
 * http.ServeContent does, for one range; the tail read's large log is generated here.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** A byte range of a file, both ends inclusive. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * What a Range header asks of a file of `size` bytes, as Go's http.ServeContent reads one
 * range: null for the whole file (no header, another unit, or more than one range, which
 * the mock does not split), the range, or "unsatisfiable" (416). `bytes=a-b` (b clamped to
 * the end), `bytes=a-`, `bytes=-n` (the last n).
 */
export function byteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header?.startsWith("bytes=")) return null;
  const spec = header.slice("bytes=".length).trim();
  if (spec.includes(",")) return null;
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === "" && m[2] === "")) return "unsatisfiable";
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** Serves a media file's bytes with the daemon's headers: the whole file, the range asked, or 416. */
export function serveMedia(req: IncomingMessage, res: ServerResponse, data: Uint8Array, mime: string): void {
  const headers = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox",
  };
  const header = req.headers.range;
  const r = byteRange(typeof header === "string" ? header : undefined, data.length);
  if (r === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${String(data.length)}` });
    res.end();
    return;
  }
  const body = r ? data.subarray(r.start, r.end + 1) : data;
  res.writeHead(r ? 206 : 200, {
    ...headers,
    "Content-Length": String(body.length),
    ...(r ? { "Content-Range": `bytes ${String(r.start)}-${String(r.end)}/${String(data.length)}` } : {}),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * The end of a text file's bytes as the daemon's tail read takes it (internal/fsx ReadTail):
 * from the first line that starts in the last `limit` bytes, else the first whole character.
 */
export function tailOf(data: Uint8Array, limit: number): { contents: Uint8Array; offset: number } {
  if (data.length <= limit) return { contents: data, offset: 0 };
  const start = data.length - limit - 1;
  const b = data.subarray(start);
  let skip = 1;
  const nl = b.subarray(0, b.length - 1).indexOf(10);
  if (nl >= 0) skip = nl + 1;
  else for (let k = 0; k < 3 && skip < b.length && ((b[skip] ?? 0) & 0xc0) === 0x80; k++) skip++;
  return { contents: b.slice(skip), offset: start + skip };
}

const LEVELS = ["INFO", "INFO", "INFO", "DEBUG", "INFO", "WARN", "INFO", "ERROR"] as const;
const MESSAGES = [
  "request served method=GET path=/api/threads status=200 dur=4ms",
  "worktree refreshed project=code-foundry files=1284",
  "cache miss key=thread:s-1 fetching from disk",
  "slow query took=812ms table=threads",
  "watcher restarted after FSEvents overflow",
  'retrying gh call attempt=2 err="502 Bad Gateway"',
  "terminal attached id=t-s1-shell cols=120 rows=32",
  "failed to read settings: unexpected end of JSON input",
] as const;

/**
 * A log of at least `bytes` bytes: timestamped lines with levels (some coloured with ANSI
 * escapes, as a dev server writes them), numbered so the newest line is easy to find. The
 * last line is "line <n> · the end".
 */
export function mockLog(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  const t0 = Date.UTC(2026, 10, 14, 9, 0, 0);
  for (let i = 1; size < bytes; i++) {
    const level = LEVELS[i % LEVELS.length] ?? "INFO";
    const msg = MESSAGES[i % MESSAGES.length] ?? "";
    const stamp = new Date(t0 + i * 37).toISOString();
    const lvl = level === "ERROR" ? `\u001b[31m${level}\u001b[0m` : level === "WARN" ? `\u001b[33m${level}\u001b[0m` : level;
    const line = `${stamp} ${lvl} line ${String(i)} ${msg}`;
    lines.push(line);
    size += line.length + 1;
  }
  const n = lines.length + 1;
  lines.push(`${new Date(t0 + n * 37).toISOString()} INFO line ${String(n)} · the end`);
  return lines.join("\n") + "\n";
}
