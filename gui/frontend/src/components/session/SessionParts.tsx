import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2, Unplug } from "lucide-react";
import { SessionStatusIcon } from "./SessionStatusIcon";
import { Button } from "@/components/ui/button";
import { basename, tildify } from "@/lib/path";
import { badgeLabels, disconnectReason, formatAgo, sessionBadge } from "@/lib/session";
import { reconnectSession, removeSession } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

/** Re-renders every `ms` so relative times stay fresh. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(t);
    };
  }, [ms]);
  return now;
}

/** Left side of the terminal header when the terminal belongs to a session. */
export function SessionTitle({ id }: { id: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name || "New session");
  const model = useSessionsStore((s) => [s.byId[id]?.model, s.byId[id]?.effort].filter(Boolean).join(" · "));
  const path = useSessionsStore((s) => s.byId[id]?.worktreePath ?? "");
  const badge = useSessionsStore((s) => sessionBadge(s.byId[id]));
  return (
    <>
      <SessionStatusIcon id={id} />
      <span className="truncate font-medium text-foreground" data-testid="terminal-title">
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

/** Thin "starting…" / "closing…" indicator over a session's terminal. */
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

/**
 * The content pane for a session with no terminal: why it stopped, when it was last
 * active, and one primary action (Reconnect). Remove is secondary.
 */
export function SessionDisconnected({ id }: { id: string }) {
  const s = useSessionsStore((st) => st.byId[id]);
  const loaded = useSessionsStore((st) => st.loaded || st.availability !== "unknown");
  const now = useNow();
  const [pending, setPending] = useState<"reconnect" | "remove" | null>(null);

  if (!s) {
    return (
      <section className="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground" data-region="content" data-testid="session-missing">
        {loaded ? "This session no longer exists." : "Loading session…"}
      </section>
    );
  }

  const reconnect = async () => {
    setPending("reconnect");
    const ok = await reconnectSession(id);
    setPending(null);
    if (ok) useUiStore.setState((u) => ({ terminalFocusSeq: u.terminalFocusSeq + 1 }));
  };
  const remove = async () => {
    setPending("remove");
    const ok = await removeSession(id);
    setPending(null);
    if (ok && useUiStore.getState().selection.kind === "session") useUiStore.getState().select({ kind: "none" });
  };

  return (
    <section className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-10" data-region="content" aria-label="Session" data-testid="session-disconnected">
      <div className="mt-[14vh] flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border bg-muted/40">
          <Unplug className="size-5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold" data-testid="session-title">
            {s.name || "New session"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Not connected · <span data-testid="disconnect-reason">{disconnectReason(s)}</span>
          </p>
        </div>
        <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 rounded-lg border px-4 py-3 text-left text-xs">
          <dt className="text-muted-foreground">Last activity</dt>
          <dd data-testid="last-activity" title={s.lastActivityAtMs ? new Date(s.lastActivityAtMs).toLocaleString() : ""}>
            {formatAgo(s.lastActivityAtMs, now)}
          </dd>
          <dt className="text-muted-foreground">Worktree</dt>
          <dd className="truncate font-mono" title={s.worktreePath}>
            {basename(s.worktreePath)}
          </dd>
          {(s.model || s.effort) && (
            <>
              <dt className="text-muted-foreground">Model</dt>
              <dd>{[s.model, s.effort].filter(Boolean).join(" · ")}</dd>
            </>
          )}
        </dl>
        <div className="flex items-center gap-2">
          <Button autoFocus onClick={() => void reconnect()} disabled={pending !== null} data-testid="reconnect">
            {pending === "reconnect" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Reconnect
          </Button>
          <Button variant="ghost" onClick={() => void remove()} disabled={pending !== null} data-testid="remove-session">
            {pending === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Remove
          </Button>
        </div>
      </div>
    </section>
  );
}
