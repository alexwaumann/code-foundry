/**
 * Staged attachments a thread shows (ThreadService.ReadAttachment): images and PDFs in its
 * user messages, images in its markdown. Fetched once per path and kept as the blob and its
 * object URL, up to FILE_BUDGET bytes: past that the least recently used ones that no
 * mounted component shows are dropped (their URLs revoked) and fetched again if they come
 * back on screen. A window stays open for days; keeping every screenshot and PDF it ever
 * showed grew without bound. A path the daemon no longer has (reaped after 7 days)
 * resolves to null and the chip shows it as missing. A failed fetch (the daemon down or
 * restarting) is not remembered: the next chip that mounts asks again. A PDF's page count
 * and first-page thumbnail (lib/pdf) are worked out once per path (small; kept).
 */
import { useEffect, useState } from "react";
import { readAttachment } from "@/api/threads";
import { pdfSummary } from "@/lib/pdf";
import { kindFromName } from "@/lib/prompt";

/** A loaded attachment: the file (typed, so pdf.js and <img> read it) and its object URL. */
export interface LoadedAttachment {
  url: string;
  file: Blob;
}

/** A PDF's page count and first page (a PNG data URL, null when it did not render). */
export interface PdfSummary {
  pages: number;
  thumb: string | null;
}

type Entry<T> = { value: T | null; done: boolean; wait: Promise<T | null> };

/** How many bytes of loaded files stay cached once nothing mounted shows them. */
export const FILE_BUDGET = 256 * 1024 * 1024;

// Map order is recency: a hit moves its entry to the end, eviction starts at the front.
const files = new Map<string, Entry<LoadedAttachment>>();
const summaries = new Map<string, Entry<PdfSummary>>();
/** How many mounted components show each file path (useAttachment): those are never evicted. */
const pins = new Map<string, number>();

function cachedBytes(): number {
  let n = 0;
  for (const e of files.values()) n += e.value?.file.size ?? 0;
  return n;
}

/** Drops least recently used, unpinned, loaded files (but `keep`) until the cache fits FILE_BUDGET. */
function evict(keep = ""): void {
  let over = cachedBytes() - FILE_BUDGET;
  for (const [path, e] of files) {
    if (over <= 0) return;
    if (!e.done || path === keep || (pins.get(path) ?? 0) > 0) continue;
    files.delete(path);
    if (e.value) {
      over -= e.value.file.size;
      URL.revokeObjectURL(e.value.url);
    }
  }
}

/** Marks a file path as shown by a mounted component until the returned function runs. */
function pin(path: string): () => void {
  pins.set(path, (pins.get(path) ?? 0) + 1);
  return () => {
    const n = (pins.get(path) ?? 1) - 1;
    if (n > 0) pins.set(path, n);
    else pins.delete(path);
    // Just shown: the last to go.
    const e = files.get(path);
    if (e) {
      files.delete(path);
      files.set(path, e);
    }
    evict();
  };
}

/** load(key) once per key; a rejection is not remembered (resolves to null, the next call asks again). */
function cached<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) {
    // Most recently used: to the back of the eviction order.
    cache.delete(key);
    cache.set(key, hit);
    return hit.wait;
  }
  const entry: Entry<T> = { value: null, done: false, wait: Promise.resolve(null) };
  entry.wait = load()
    .catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
      return null;
    })
    .then((value) => {
      entry.value = value;
      entry.done = true;
      return value;
    });
  cache.set(key, entry);
  return entry.wait;
}

/** { value, loading } of cached(cache, key, …) for a component ("" key: nothing to load). */
function useCached<T>(cache: Map<string, Entry<T>>, key: string, load: (key: string) => Promise<T | null>): { value: T | null; loading: boolean } {
  const hit = key ? cache.get(key) : undefined;
  const [state, setState] = useState<{ key: string; value: T | null } | null>(null);
  useEffect(() => {
    if (!key || cache.get(key)?.done) return;
    let live = true;
    void load(key).then((value) => {
      if (live) setState({ key, value });
    });
    return () => {
      live = false;
    };
  }, [cache, key, load]);
  if (!key) return { value: null, loading: false };
  if (hit?.done) return { value: hit.value, loading: false };
  if (state?.key === key) return { value: state.value, loading: false };
  return { value: null, loading: true };
}

/** The blob's type: the daemon's, else a ".pdf" path's (the daemon names staged files by their sniffed type). */
function typeOf(path: string, mimeType: string): string {
  if (mimeType) return mimeType;
  return kindFromName(path) === "pdf" ? "application/pdf" : "";
}

/** A staged attachment's file, read from the daemon without caching it (null when it is gone). */
export async function readAttachmentFile(path: string): Promise<Blob | null> {
  const res = await readAttachment(path);
  return res ? new Blob([new Uint8Array(res.data)], { type: typeOf(path, res.mimeType) }) : null;
}

/** A staged attachment's file and object URL (null when it is gone). */
export async function loadAttachment(path: string): Promise<LoadedAttachment | null> {
  const loaded = await cached(files, path, async () => {
    const file = await readAttachmentFile(path);
    return file ? { url: URL.createObjectURL(file), file } : null;
  });
  // The caller is about to use this one's URL: make room among the others.
  evict(path);
  return loaded;
}

/** The object URL of a staged attachment (null while loading or when it is gone). */
export async function loadAttachmentUrl(path: string): Promise<string | null> {
  return (await loadAttachment(path))?.url ?? null;
}

/**
 * A staged PDF's summary (null when it is gone or pdf.js cannot read it, both remembered;
 * a failed fetch is not).
 */
export function loadPdfSummary(path: string): Promise<PdfSummary | null> {
  return cached(summaries, path, async () => {
    const att = await loadAttachment(path);
    if (!att) {
      if (!files.has(path)) throw new Error(`attachment ${path} did not load`);
      return null;
    }
    return pdfSummary(att.file, 128).catch(() => null);
  });
}

/** { url, file, loading } for a staged attachment path ("" path: nothing to load). Pinned in the cache while mounted. */
export function useAttachment(path: string): { url: string | null; file: Blob | null; loading: boolean } {
  useEffect(() => (path ? pin(path) : undefined), [path]);
  const { value, loading } = useCached(files, path, loadAttachment);
  return { url: value?.url ?? null, file: value?.file ?? null, loading };
}

/** { url, loading } for a staged attachment path ("" path: nothing to load). */
export function useAttachmentUrl(path: string): { url: string | null; loading: boolean } {
  const { url, loading } = useAttachment(path);
  return { url, loading };
}

/** A staged PDF's summary, null until it is known ("" path: none). */
export function usePdfSummary(path: string): PdfSummary | null {
  return useCached(summaries, path, loadPdfSummary).value;
}
