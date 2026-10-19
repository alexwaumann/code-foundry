/**
 * The user's backdrop images (SettingsService.ReadBackdrop), for the Custom backdrop and
 * the settings gallery's thumbnails. One fetch per name for the window's life, kept as an
 * object URL (the pattern of stores/attachments.ts). A name the daemon no longer has
 * resolves to null, and that is remembered until forgetBackdrop (the gallery's remove)
 * drops it; a failed fetch (the daemon down or restarting) is not: the next mount asks
 * again. Names are content hashes, so a name never comes back with other bytes.
 */
import { useEffect, useState } from "react";
import { readBackdrop } from "@/api/settings";

/** appearance.backdrop's value for the user's own image (appearance.backdrop_file). */
export const CUSTOM_BACKDROP = "custom";

type Entry = { url: string | null; done: boolean; wait: Promise<string | null> };

const urls = new Map<string, Entry>();

/** A backdrop image's object URL, fetched once per name (null when it is gone). */
export function loadBackdropUrl(name: string): Promise<string | null> {
  const hit = urls.get(name);
  if (hit) return hit.wait;
  const entry: Entry = { url: null, done: false, wait: Promise.resolve(null) };
  entry.wait = readBackdrop(name)
    .then((res) => (res ? URL.createObjectURL(new Blob([new Uint8Array(res.data)], { type: res.mimeType })) : null))
    .catch(() => {
      if (urls.get(name) === entry) urls.delete(name);
      return null;
    })
    .then((url) => {
      entry.url = url;
      entry.done = true;
      return url;
    });
  urls.set(name, entry);
  return entry.wait;
}

/** Drops a removed image's object URL, so a later import of the same picture fetches it again. */
export function forgetBackdrop(name: string): void {
  const hit = urls.get(name);
  urls.delete(name);
  if (hit?.url) URL.revokeObjectURL(hit.url);
}

/** Test hook: forget every cached image. */
export function resetBackdropCache(): void {
  for (const name of [...urls.keys()]) forgetBackdrop(name);
}

/** { url, loading } of a backdrop image ("" name: nothing to load, not loading). */
export function useBackdropUrl(name: string): { url: string | null; loading: boolean } {
  const hit = name ? urls.get(name) : undefined;
  const [state, setState] = useState<{ name: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!name || urls.get(name)?.done) return;
    let live = true;
    void loadBackdropUrl(name).then((url) => {
      if (live) setState({ name, url });
    });
    return () => {
      live = false;
    };
  }, [name]);
  if (!name) return { url: null, loading: false };
  if (hit?.done) return { url: hit.url, loading: false };
  if (state?.name === name) return { url: state.url, loading: false };
  return { url: null, loading: true };
}
