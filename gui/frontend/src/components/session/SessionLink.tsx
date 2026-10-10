import type { ReactNode } from "react";
import { SessionStatusIcon } from "@/components/session/SessionStatusIcon";
import { badgeLabels, sessionBadge } from "@/lib/session";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

/**
 * A thread row on an overview page: status, name, and a muted detail on the right.
 * Clicking selects the thread and focuses its terminal. Defaults to the status icon and
 * badge label; `icon` and `detail` replace them.
 */
export function SessionLink({ id, icon, detail }: { id: string; icon?: ReactNode; detail?: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name || id);
  const badge = useSessionsStore((s) => badgeLabels[sessionBadge(s.byId[id])]);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      data-session-link={id}
      onClick={() => {
        useUiStore.getState().select({ kind: "session", id }, { focusTerminal: true });
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon ?? <SessionStatusIcon id={id} />}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{detail ?? badge}</span>
    </button>
  );
}
