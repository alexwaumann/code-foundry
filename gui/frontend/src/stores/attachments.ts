/**
 * Staged attachments a thread shows (ThreadService.ReadAttachment): images and PDFs in its
 * user messages, images in its markdown. One fetch per path for the window's life, kept as
 * the blob and its object URL; a path the daemon no longer has (reaped after 7 days)
 * resolves to null and the chip shows it as missing. A failed fetch (the daemon down or
 * restarting) is not remembered: the next chip that mounts asks again. A PDF's page count
 * and first-page thumbnail (lib/pdf) are worked out once per path too.
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

const files = new Map<string, Entry<LoadedAttachment>>();
const summaries = new Map<string, Entry<PdfSummary>>();

/** load(key) once per key; a rejection is not remembered (resolves to null, the next call asks again). */
function cached<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) return hit.wait;
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

/** A staged attachment's file and object URL (null when it is gone). */
export function loadAttachment(path: string): Promise<LoadedAttachment | null> {
  return cached(files, path, async () => {
    const res = await readAttachment(path);
    if (!res) return null;
    const file = new Blob([new Uint8Array(res.data)], { type: typeOf(path, res.mimeType) });
    return { url: URL.createObjectURL(file), file };
  });
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

/** { url, file, loading } for a staged attachment path ("" path: nothing to load). */
export function useAttachment(path: string): { url: string | null; file: Blob | null; loading: boolean } {
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
