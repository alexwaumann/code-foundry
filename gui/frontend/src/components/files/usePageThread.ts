import { useMemo } from "react";
import type { FilePreview } from "@/api/files";
import type { PageAccessView } from "@/api/page";
import { NOT_ALLOWED, pageUnavailable } from "@/lib/bridge";
import { usePanelKey } from "@/shell/panelKeyContext";
import { inlinePage } from "@/lib/inlinePage";
import type { PageBridge } from "@/stores/bridgeHost";
import { useThreadStore } from "@/stores/thread";

const THREAD_KEY = "thread:";

/**
 * Whom a File tab's HTML page acts for, and what it may do (docs/notes/page-ownership-gui.md).
 *
 * The daemon decides (the grant's `page`, FilePreview.page; docs/notes/page-ownership-daemon.md,
 * page-storage-per-file.md): a page threads own (each that showed or wrote it, and the thread
 * whose pages directory holds it) acts for the tab's own thread when that is one of them, and
 * otherwise for the page's first owner (`ownerThread`), which stays the same whoever shows the
 * page later, whether or not the thread's view was ever open; `actsFor` names that thread when
 * it is not the tab's own. So a tab opened from a thread's card (linked to that thread, which
 * owns the page it showed) acts for the card's thread, as the card does. A page no thread owns
 * gets the bridge without a thread once the user allowed it, and asks (`ask`) when they have
 * not answered; one they refused, or a file that is no page (`unavailable`), gets every call
 * refused with the reason. Whatever it acts for, its cf.storage is its file's (`storagePath`)
 * when the daemon keeps storage per file.
 *
 * From a daemon older than ownership (no `page`) it is as before (docs/notes/bridge-2-gui.md):
 * the thread whose panel holds the tab, when that thread showed this very file as a page (an
 * html item in its log: view.inline, its card's Open in a tab, `--panel`), or opened it as
 * its own with no card (view.panel.page: `own`, the tab's page flag), or the file lies in that
 * thread's pages directory (`pageThread`, docs/notes/page-bridge-without-log.md); any other
 * file has no bridge.
 *
 * The title is the tab's own (`own`), else the latest the owning thread's log showed the file
 * with (the log may be absent: "" then).
 */
export function usePageThread(abs: string, own?: { title: string }, preview?: FilePreview | null): PageOf {
  const key = usePanelKey();
  const tabThread = key.startsWith(THREAD_KEY) ? key.slice(THREAD_KEY.length) : "";
  const access = preview?.page ?? null;
  const owner = access?.consent === "owned" ? actingOwner(access, tabThread) : "";
  const logThread = owner || tabThread;
  // The log's items change as the thread streams; the scan runs only when they do.
  const byId = useThreadStore((s) => (logThread ? s.logs[logThread]?.byId : undefined));
  const shown = useMemo(() => {
    if (!byId || !abs) return null;
    let found: { title: string } | null = null;
    for (const it of Object.values(byId)) {
      if (it.kind !== "html") continue;
      const page = inlinePage(it);
      // The latest showing's title (a page shown again after an edit may have a new one).
      if (page.abs === abs && (found === null || page.title)) found = { title: page.title };
    }
    return found;
  }, [byId, abs]);
  // The tab's own title wins: it is what the user sees on the tab.
  const ownTitle = own?.title;
  const pageThread = preview?.pageThread ?? "";
  return useMemo(() => {
    const title = ownTitle || shown?.title || "";
    if (access) return fromAccess(access, tabThread, title);
    // An older daemon: the tab's thread, when its log, the page flag or its pages directory says so.
    const inPages = pageThread !== "" && pageThread === tabThread;
    const legacy = tabThread !== "" && abs !== "" && (ownTitle !== undefined || inPages || shown !== null);
    return { thread: legacy ? tabThread : null, title: legacy ? title : "", actsFor: "", access: null, storagePath: null };
  }, [access, tabThread, ownTitle, shown, pageThread, abs]);
}

/**
 * The owner a page acts for in a view of `viewThread` ("" for none): that thread when it owns
 * the page, else the page's first owner. "" for a page no thread owns.
 */
export function actingOwner(access: PageAccessView, viewThread: string): string {
  if (viewThread !== "" && access.owners.some((o) => o.thread === viewThread)) return viewThread;
  return access.ownerThread;
}

/**
 * The page file a page acting for a thread keeps its cf.storage for: its own path when the
 * daemon keeps storage per file and the page may use it (owned, or allowed); null for the
 * thread's own (an older daemon, a file that is no page).
 */
export function pageStoragePath(access: PageAccessView | null | undefined): string | null {
  if (!access?.storagePerFile || !access.path) return null;
  return access.consent === "owned" || access.consent === "allowed" ? access.path : null;
}

function fromAccess(access: PageAccessView, tabThread: string, title: string): PageOf {
  switch (access.consent) {
    case "owned": {
      const thread = actingOwner(access, tabThread);
      return { thread, title, actsFor: thread === tabThread ? "" : thread, access, storagePath: pageStoragePath(access) };
    }
    case "allowed":
      return { thread: null, title, actsFor: "", access, bridge: { kind: "allowed", path: access.path }, storagePath: null };
    case "not-asked":
      return { thread: null, title, actsFor: "", access, bridge: { kind: "ask" }, storagePath: null };
    case "refused":
      return { thread: null, title, actsFor: "", access, bridge: { kind: "refused", error: NOT_ALLOWED }, storagePath: null };
    case "unavailable":
      return { thread: null, title, actsFor: "", access, bridge: { kind: "refused", error: pageUnavailable(access.unavailableReason) }, storagePath: null };
  }
}

/** Whom a File tab's page acts for and what it may do. */
export interface PageOf {
  /** The thread the page acts for (its bridge); null for none. */
  thread: string | null;
  /** The page file whose storage a page acting for `thread` keeps (HtmlFrame's `storagePath`); null: the thread's own (an older daemon) or no thread. */
  storagePath: string | null;
  /** The title it was shown with; "" for none. */
  title: string;
  /** The thread the page acts for when that is not the tab's own thread (or the tab has none), to name it; "" otherwise. */
  actsFor: string;
  /** The daemon's word; null from a daemon older than page ownership. */
  access: PageAccessView | null;
  /** What a page with no thread may do (HtmlFrame's `page`); absent with a thread, and from an older daemon (nothing). */
  bridge?: PageBridge;
}
