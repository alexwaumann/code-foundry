import { useMemo } from "react";
import { usePanelKey } from "@/components/panel/panelKeyContext";
import { inlinePage } from "@/lib/inlinePage";
import { useThreadStore } from "@/stores/thread";

const THREAD_KEY = "thread:";

/**
 * The thread a File tab's HTML page belongs to, for its bridge (docs/notes/bridge-2-gui.md):
 * the thread whose panel holds the tab, when that thread showed this very file as a page
 * (an html item: view.inline, its card's Open in side panel, `--panel`). Any other HTML
 * file, in any panel, has none: its bridge refuses every call.
 */
export function usePageThread(abs: string): PageOf | null {
  const key = usePanelKey();
  const threadId = key.startsWith(THREAD_KEY) ? key.slice(THREAD_KEY.length) : "";
  // The log's items change as the thread streams; the scan runs only when they do.
  const byId = useThreadStore((s) => (threadId ? s.logs[threadId]?.byId : undefined));
  return useMemo(() => {
    if (!byId || !abs) return null;
    let found: PageOf | null = null;
    for (const it of Object.values(byId)) {
      if (it.kind !== "html") continue;
      const page = inlinePage(it);
      // The latest showing's title (a page shown again after an edit may have a new one).
      if (page.abs === abs && (found === null || page.title)) found = { thread: threadId, title: page.title };
    }
    return found;
  }, [byId, abs, threadId]);
}

/** The thread a File tab's page belongs to, and the title it was shown with ("" for none). */
export interface PageOf {
  thread: string;
  title: string;
}
