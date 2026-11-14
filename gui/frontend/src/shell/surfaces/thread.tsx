import { MessageSquare } from "lucide-react";
import { ThreadWithQuick } from "@/components/shell/QuickTerminal";
import { ThreadPane } from "@/components/thread/ThreadPane";
import { isAttention, useThreadsStore } from "@/stores/threads";
import type { ShellSurface } from "./types";

/**
 * A thread's own tab: its conversation (components/thread/ThreadPane), which holds the
 * thread's WatchThread while mounted. The name is the thread's, looked up by id, so a rename
 * shows at once; the layout's stored title is only the fallback before the threads arrive.
 * In a shell pane ThreadPane draws the shell's header (components/thread/ThreadHeader.tsx). Under
 * it, while open, the thread's quick terminal (components/shell/QuickTerminal.tsx). A thread that
 * needs the user (stores/threads isAttention; not when archived) marks its tab's icon, active or not.
 */
export const threadSurface: ShellSurface = {
  kind: "thread",
  icon: MessageSquare,
  useTitle: (tab) => {
    const name = useThreadsStore((s) => s.byId[tab.thread]?.name ?? "");
    return name || tab.title || "Thread";
  },
  render: (tab) => (
    <ThreadWithQuick threadId={tab.thread}>
      <ThreadPane threadId={tab.thread} />
    </ThreadWithQuick>
  ),
  useAttention: (tab) =>
    useThreadsStore((s) => {
      const t = s.byId[tab.thread];
      return t !== undefined && t.archivedAtMs === null && isAttention(t);
    }),
};
