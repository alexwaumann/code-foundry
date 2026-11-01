import { useEffect } from "react";
import { create } from "zustand";
import { invalidateOnTransportError } from "@/api/endpoint";
import { listAppIcons } from "@/api/gitops";

/**
 * Installed apps' icons (Finder's, the editors'), read once per session from the daemon
 * (GitOpsService.ListAppIcons): bundle id → PNG data URL, or null when the app has none.
 * Ids asked for in one tick go out as one request.
 */
export const useAppIconsStore = create<{ urls: Readonly<Record<string, string | null>> }>()(() => ({ urls: {} }));

/** Ids asked for (in flight or answered); a failed request forgets its ids so a later ask retries. */
const requested = new Set<string>();
const pending = new Set<string>();
let scheduled = false;

async function flush(): Promise<void> {
  scheduled = false;
  const ids = [...pending];
  pending.clear();
  try {
    const got = await listAppIcons(ids);
    useAppIconsStore.setState((s) => {
      const urls = { ...s.urls };
      for (const id of ids) urls[id] = got.get(id) ?? null;
      return { urls };
    });
  } catch (err) {
    invalidateOnTransportError(err);
    for (const id of ids) requested.delete(id);
  }
}

/** Asks for bundleId's icon unless already asked for; batched within the tick. */
export function requestAppIcon(bundleId: string): void {
  if (!bundleId || requested.has(bundleId)) return;
  requested.add(bundleId);
  pending.add(bundleId);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => void flush());
  }
}

/** bundleId's icon as a data URL; undefined while loading or when the app has none. */
export function useAppIcon(bundleId: string): string | undefined {
  useEffect(() => {
    requestAppIcon(bundleId);
  }, [bundleId]);
  return useAppIconsStore((s) => s.urls[bundleId] ?? undefined);
}

/** Tests: forget every icon and request. */
export function resetAppIconsForTests(): void {
  requested.clear();
  pending.clear();
  scheduled = false;
  useAppIconsStore.setState({ urls: {} });
}
