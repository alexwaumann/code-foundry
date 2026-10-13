import { Loader2 } from "lucide-react";
import { SessionStatusIcon } from "./SessionStatusIcon";
import { tildify } from "@/lib/path";
import { badgeLabels, sessionBadge } from "@/lib/session";
import { useSessionsStore } from "@/stores/sessions";

/** Left side of a thread's header: status, name, badge, model and worktree. */
export function SessionTitle({ id }: { id: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name || id);
  const model = useSessionsStore((s) => [s.byId[id]?.model, s.byId[id]?.effort].filter(Boolean).join(" · "));
  const path = useSessionsStore((s) => s.byId[id]?.worktreePath ?? "");
  const badge = useSessionsStore((s) => sessionBadge(s.byId[id]));
  return (
    <>
      <SessionStatusIcon id={id} />
      <span className="truncate font-medium text-foreground" data-testid="thread-title">
        {name}
      </span>
      <span className="shrink-0 text-muted-foreground" data-testid="session-badge-text">
        {badgeLabels[badge]}
      </span>
      {model && <span className="shrink-0 text-muted-foreground">{model}</span>}
      <span className="truncate text-muted-foreground">{tildify(path)}</span>
    </>
  );
}

/** Thin "starting…" / "closing…" indicator over a thread's conversation. */
export function SessionIndicator({ id }: { id: string }) {
  const state = useSessionsStore((s) => s.byId[id]?.state);
  if (state !== "starting" && state !== "closing") return null;
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden>
        <div className="h-full w-1/3 animate-[cf-indeterminate_1.4s_ease-in-out_infinite] bg-sky-400/70" />
      </div>
      <div
        className="pointer-events-none absolute top-2 right-4 flex items-center gap-1.5 rounded-md border bg-popover/90 px-2 py-0.5 text-[11px] text-muted-foreground"
        data-testid="session-indicator"
        data-state={state}
      >
        <Loader2 className="size-3 animate-spin" />
        {state === "starting" ? "starting…" : "closing…"}
      </div>
    </>
  );
}
