/**
 * A thread's page storage (docs/notes/bridge-fix-storage.md): what the pages it shows keep
 * with the bridge's cf.storage, kept by the daemon because WebKit keeps a page frame's own
 * localStorage for the session only. Key → the value's JSON text. Reads and writes of a
 * page's own state, not user actions: no command.
 */
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type PageStorageValues = Record<string, string>;

/** ThreadService.PageStorage: the thread's whole storage. */
export async function getPageStorage(threadId: string, conn: DaemonConnection = daemon): Promise<PageStorageValues> {
  const c = await conn.client(ThreadService);
  const res = await c.pageStorage({ threadId });
  return { ...res.values };
}

/** ThreadService.SetPageStorage: sets key to value's JSON text, or removes it (null); the storage after. */
export async function setPageStorage(threadId: string, key: string, value: string | null, conn: DaemonConnection = daemon): Promise<PageStorageValues> {
  const c = await conn.client(ThreadService);
  const res = await c.setPageStorage(value === null ? { threadId, key } : { threadId, key, value });
  return { ...res.values };
}
