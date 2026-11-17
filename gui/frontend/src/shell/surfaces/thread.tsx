import { MessageSquare } from "lucide-react";
import { ThreadWithQuick } from "@/components/shell/QuickTerminal";
import { threadTabMenuKeepsFocus } from "@/components/thread/menuKit";
import { ThreadTabMenu } from "@/components/thread/ThreadMenu";
import { ThreadPane } from "@/components/thread/ThreadPane";
import { statusLine } from "@/lib/statusLine";
import { useNameProvisional } from "@/shell/useThreadName";
import { useThreadsStore } from "@/stores/threads";
import type { ShellSurface } from "./types";

/**
 * A thread's own tab: its conversation (components/thread/ThreadPane), which holds the
 * thread's WatchThread while mounted. The name is the thread's, looked up by id, so a rename
 * shows at once; the layout's stored title is only the fallback before the threads arrive. While
 * the name is provisional or being regenerated the tab's title is muted and italic, as the row is.
 * In a shell pane ThreadPane draws the shell's header (components/thread/ThreadHeader.tsx). Under
 * it, while open, the thread's quick terminal (components/shell/QuickTerminal.tsx). The thread's
 * status (lib/statusLine, the sidebar row's) marks its tab's icon with a dot in the status's
 * colour, active or not: none while idle or archived.
 * A right click on the tab shows the thread's menu, the header's (components/thread/ThreadMenu.tsx).
 */
export const threadSurface: ShellSurface = {
  kind: "thread",
  icon: MessageSquare,
  useTitle: (tab) => {
    const name = useThreadsStore((s) => s.byId[tab.thread]?.name ?? "");
    return name || tab.title || "Thread";
  },
  // Muted and italic while the name is provisional or being regenerated, as the sidebar's row.
  useNameProvisional: (tab) => useNameProvisional(tab.thread),
  render: (tab) => (
    <ThreadWithQuick threadId={tab.thread}>
      <ThreadPane threadId={tab.thread} />
    </ThreadWithQuick>
  ),
  tabMenu: (tab) => <ThreadTabMenu tab={tab} />,
  tabMenuKeepsFocus: threadTabMenuKeepsFocus,
  useStatus: (tab) =>
    useThreadsStore((s) => {
      const t = s.byId[tab.thread];
      if (t === undefined || t.archivedAtMs !== null) return null;
      const kind = statusLine(t).kind;
      return kind === "place" ? null : kind;
    }),
};
