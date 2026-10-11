import { useEffect, useState, type ReactNode } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { SessionStatusIcon } from "./SessionStatusIcon";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { Button } from "@/components/ui/button";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { DragBand } from "@/components/window/DragBand";
import { tildify } from "@/lib/path";
import { badgeLabels, disconnectCause, disconnectedPill, formatAgo, modelEffortLabel, sessionBadge, sessionLocation, type PillKind } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useReposStore } from "@/stores/repos";
import { reconnectSession, removeSession } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { DASHBOARD, useUiStore } from "@/stores/ui";

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
  const name = useSessionsStore((s) => s.byId[id]?.name || id);
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

/** The disconnected page's frame: the start page's backdrop and centring, and the pane's drag band. */
function DisconnectedFrame({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Backdrop />
      {/* Auto margins in a column flexbox centre the block and, unlike justify-center,
          fall back to 0 (scrollable from the top) when it outgrows the pane. */}
      <section
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-10 outline-none"
        tabIndex={-1}
        data-focus-root
        data-region="content"
        aria-label="Thread"
        data-testid={testId}
      >
        {children}
      </section>
      <DragBand />
    </div>
  );
}

const pillDots: Record<PillKind, string | null> = {
  interrupted: "size-1.5 rounded-full bg-red-400",
  attention: "size-1.5 rounded-full bg-amber-400",
  idle: "size-[7px] rounded-full border-[1.5px] border-muted-foreground",
  none: null,
};

/** "<what Claude was doing> · <why it disconnected>", or a spinner while a reconnect runs. */
function StatusPill({ id, reconnecting }: { id: string; reconnecting: boolean }) {
  const pill = useSessionsStore(useShallow((st) => disconnectedPill(st.byId[id] ?? { status: "unknown", statusReason: "" })));
  const cause = useSessionsStore((st) => {
    const s = st.byId[id];
    return s ? disconnectCause(s) : "";
  });
  const dot = pillDots[pill.kind];
  return (
    <span
      className={cn("inline-flex h-6 max-w-full items-center gap-[7px] rounded-full border bg-card/70 pr-2.5 text-xs text-muted-foreground backdrop-blur-md", dot || reconnecting ? "pl-2" : "pl-2.5")}
      data-testid="status-pill"
      data-status-kind={pill.kind}
    >
      {reconnecting ? (
        <>
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
          Reconnecting…
        </>
      ) : (
        <>
          {dot && <span aria-hidden className={cn("shrink-0", dot)} />}
          <span className="truncate">
            {pill.label && `${pill.label} · `}
            <span data-testid="disconnect-reason">{cause}</span>
          </span>
        </>
      )}
    </span>
  );
}

function MetaSep() {
  return (
    <span aria-hidden className="opacity-50">
      ·
    </span>
  );
}

/** Last activity · project @ branch · model, centred and wrapping. */
function MetaLine({ id }: { id: string }) {
  const now = useNow();
  const lastActivityAtMs = useSessionsStore((st) => st.byId[id]?.lastActivityAtMs ?? null);
  const worktreePath = useSessionsStore((st) => st.byId[id]?.worktreePath ?? "");
  const model = useSessionsStore((st) => {
    const s = st.byId[id];
    return s ? modelEffortLabel(s) : "";
  });
  const where = useReposStore(useShallow((r) => sessionLocation({ worktreePath }, r)));
  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="text-foreground" data-testid="last-activity" title={lastActivityAtMs ? new Date(lastActivityAtMs).toLocaleString() : ""}>
        {formatAgo(lastActivityAtMs, now)}
      </span>
      <MetaSep />
      <span className="min-w-0 break-words text-foreground" data-testid="session-location" title={worktreePath}>
        {where.project}
        {where.branch && (
          <>
            {" "}
            <span className="text-muted-foreground">@</span> <span className="font-mono">{where.branch}</span>
          </>
        )}
      </span>
      {model && (
        <>
          <MetaSep />
          <span className="text-foreground" data-testid="session-model">
            {model}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The content pane for a session with no terminal: a pill with what Claude was doing and
 * why it disconnected, the thread's name, where and when it last ran, and one primary
 * action (Reconnect). Remove is secondary. Design record: docs/sketches/disconnected-page.
 */
export function SessionDisconnected({ id }: { id: string }) {
  const exists = useSessionsStore((st) => id in st.byId);
  const name = useSessionsStore((st) => st.byId[id]?.name || id);
  const loaded = useSessionsStore((st) => st.loaded || st.availability !== "unknown");
  const [pending, setPending] = useState<"reconnect" | "remove" | null>(null);

  if (!exists) {
    return (
      <DisconnectedFrame testId="session-missing">
        <p className="m-auto text-sm text-muted-foreground">{loaded ? "This thread no longer exists." : "Loading thread…"}</p>
      </DisconnectedFrame>
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
    if (ok && useUiStore.getState().selection.kind === "session") useUiStore.getState().select(DASHBOARD);
  };

  return (
    <DisconnectedFrame testId="session-disconnected">
      {/* Centred in the 44px band where the other pages have their header (window/PaneHeader);
          above the drag band (z-10), which would otherwise take its clicks. */}
      <PanelToggle className="absolute top-2.5 right-1.5 z-20" />
      <div className="m-auto flex w-full max-w-[480px] flex-col items-center gap-5 text-center">
        <StatusPill id={id} reconnecting={pending === "reconnect"} />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold tracking-tight" data-testid="session-title">
            {name}
          </h1>
          <p className="text-sm text-muted-foreground">This thread is not connected. Reconnect to pick up where it left off.</p>
        </div>
        <MetaLine id={id} />
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
    </DisconnectedFrame>
  );
}
