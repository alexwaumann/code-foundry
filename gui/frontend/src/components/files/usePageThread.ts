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
export function usePageThread(abs: string): string | null {
  const key = usePanelKey();
  const threadId = key.startsWith(THREAD_KEY) ? key.slice(THREAD_KEY.length) : "";
  // The log's items change as the thread streams; the scan runs only when they do.
  const byId = useThreadStore((s) => (threadId ? s.logs[threadId]?.byId : undefined));
  return useMemo(() => {
    if (!byId || !abs) return null;
    for (const it of Object.values(byId)) if (it.kind === "html" && inlinePage(it).abs === abs) return threadId;
    return null;
  }, [byId, abs, threadId]);
}
