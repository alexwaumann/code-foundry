import type { ReactNode } from "react";
import { ThreadStatusIcon } from "@/components/thread/ThreadStatusIcon";
import { badgeLabels, threadBadge } from "@/lib/thread";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

/**
 * A thread row on an overview page: status, name, and a muted detail on the right.
 * Clicking selects the thread and focuses its prompt. Defaults to the status icon and
 * badge label; `icon` and `detail` replace them.
 */
export function ThreadLink({ id, icon, detail }: { id: string; icon?: ReactNode; detail?: string }) {
  const name = useThreadsStore((s) => s.byId[id]?.name || id);
  const badge = useThreadsStore((s) => badgeLabels[threadBadge(s.byId[id])]);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body hover:bg-accent"
      data-session-link={id}
      onClick={() => {
        useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon ?? <ThreadStatusIcon id={id} />}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-caption">{detail ?? badge}</span>
    </button>
  );
}
