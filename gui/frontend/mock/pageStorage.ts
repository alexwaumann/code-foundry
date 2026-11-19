/**
 * ThreadService.PageStorage / SetPageStorage (docs/notes/bridge-fix-storage.md): each
 * thread's own page storage, in memory for the mock's life; emptied on reset. Full past 256
 * KiB per thread, as the daemon. The GUI keeps a page's storage for its file instead
 * (PageService, mock/pages.ts; docs/notes/page-storage-per-file.md): this answers for an
 * older GUI, as the daemon's does.
 */
import { Code, ConnectError } from "@connectrpc/connect";

const MAX = 256 << 10;
const byThread = new Map<string, Record<string, string>>();

export function pageStorageOf(threadId: string): Record<string, string> {
  return { ...byThread.get(threadId) };
}

export function setPageStorage(threadId: string, key: string, value: string | undefined): Record<string, string> {
  if (key === "") throw new ConnectError("page storage needs a key", Code.InvalidArgument);
  let vals = pageStorageOf(threadId);
  if (value === undefined) vals = Object.fromEntries(Object.entries(vals).filter(([k]) => k !== key));
  else {
    try {
      JSON.parse(value);
    } catch {
      throw new ConnectError(`page storage value for "${key}" is not JSON`, Code.InvalidArgument);
    }
    vals[key] = value;
    if (JSON.stringify(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, JSON.parse(v) as unknown]))).length > MAX) {
      throw new ConnectError("page storage is full (256 KiB per thread); remove something first", Code.InvalidArgument);
    }
  }
  byThread.set(threadId, vals);
  return { ...vals };
}

export function resetPageStorage(): void {
  byThread.clear();
}
