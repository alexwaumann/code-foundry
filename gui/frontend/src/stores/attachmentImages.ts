/**
 * Object URLs for staged attachments a thread's user messages show
 * (ThreadService.ReadAttachment). One fetch per path for the window's life; a path the
 * daemon no longer has (reaped after 7 days) resolves to null and the chip shows it as
 * missing. A failed fetch (the daemon down or restarting) is not remembered: the next
 * chip that mounts asks again.
 */
import { useEffect, useState } from "react";
import { readAttachment } from "@/api/session";

type Entry = { url: string | null; done: boolean; wait: Promise<string | null> };

const cache = new Map<string, Entry>();

/** The object URL of a staged attachment (null while loading or when it is gone). */
export function loadAttachmentUrl(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) return hit.wait;
  const entry: Entry = { url: null, done: false, wait: Promise.resolve(null) };
  entry.wait = readAttachment(path)
    .then((res) => (res ? URL.createObjectURL(new Blob([new Uint8Array(res.data)], { type: res.mimeType })) : null))
    .catch(() => {
      if (cache.get(path) === entry) cache.delete(path);
      return null;
    })
    .then((url) => {
      entry.url = url;
      entry.done = true;
      return url;
    });
  cache.set(path, entry);
  return entry.wait;
}

/** { url, loading } for a staged attachment path ("" path: nothing to load). */
export function useAttachmentUrl(path: string): { url: string | null; loading: boolean } {
  const cached = path ? cache.get(path) : undefined;
  const [state, setState] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!path || cache.get(path)?.done) return;
    let live = true;
    void loadAttachmentUrl(path).then((url) => {
      if (live) setState({ path, url });
    });
    return () => {
      live = false;
    };
  }, [path]);
  if (!path) return { url: null, loading: false };
  if (cached?.done) return { url: cached.url, loading: false };
  if (state?.path === path) return { url: state.url, loading: false };
  return { url: null, loading: true };
}
