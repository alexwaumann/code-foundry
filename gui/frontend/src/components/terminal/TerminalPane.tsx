import { useEffect, useRef, useState } from "react";
import { GitFork, GitPullRequest, Layers, OctagonX, Pencil, Power } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { CommandButton } from "@/components/command/CommandButton";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { PaneHeader } from "@/components/window/PaneHeader";
import { SessionIndicator, SessionTitle } from "@/components/session/SessionParts";
import { tildify, terminalLabel } from "@/lib/path";
import { getPanel } from "@/stores/panel";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import type { RendererKind } from "@/terminal/xterm";
import { TerminalHost, type TerminalHostHandle } from "./TerminalHost";

function TerminalTitle({ id }: { id: string }) {
  const label = useTerminalsStore((s) => {
    const t = s.byId[id];
    return t ? terminalLabel(t) : id;
  });
  const cwd = useTerminalsStore((s) => s.byId[id]?.cwd ?? "");
  return (
    <>
      <span className="truncate font-medium text-foreground" data-testid="terminal-title">
        {label}
      </span>
      <span className="truncate text-muted-foreground">{tildify(cwd)}</span>
    </>
  );
}

/** view.panel.linked-prs with the thread's link count; only once the thread has linked a pull request. */
function LinkedPrsButton({ sessionId }: { sessionId: string }) {
  const count = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  return <CommandButton command="view.panel.linked-prs" icon={GitPullRequest} count={count} data-testid="pane-linked-prs" />;
}

/**
 * The pane's own commands, run against the current selection (this pane) exactly as the
 * palette runs them. Each hides when the daemon does not list it as available.
 */
function HeaderActions({ sessionId }: { sessionId: string | undefined }) {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      {sessionId !== undefined ? (
        <>
          <CommandButton command="session.rename" icon={Pencil} />
          <CommandButton command="session.fork" icon={GitFork} />
          <CommandButton command="session.close" icon={Power} />
          <LinkedPrsButton sessionId={sessionId} />
          {/* Only listed for a workspace thread (view.panel.workspace's availability). */}
          <CommandButton command="view.panel.workspace" icon={Layers} data-testid="pane-workspace" />
          <BottomToggle />
        </>
      ) : (
        <CommandButton command="terminal.kill" icon={OctagonX} />
      )}
      <PanelToggle />
    </span>
  );
}

function TerminalHeader({
  id,
  sessionId,
  size,
  renderer,
}: {
  id: string;
  sessionId: string | undefined;
  size: { cols: number; rows: number } | null;
  renderer: RendererKind | null;
}) {
  return (
    <PaneHeader className="gap-3 px-3 text-xs" data-testid="terminal-header">
      {sessionId ? <SessionTitle id={sessionId} /> : <TerminalTitle id={id} />}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground tabular-nums">
        {import.meta.env.DEV && renderer && <span className="rounded border px-1 text-[10px] uppercase">{renderer}</span>}
        {size && (
          <span>
            {size.cols}×{size.rows}
          </span>
        )}
        <HeaderActions sessionId={sessionId} />
      </span>
    </PaneHeader>
  );
}

/**
 * The content pane's terminal: a header (the thread's or the terminal's title, its size,
 * the pane's commands) over the one attached terminal (TerminalHost). The host stays
 * mounted across terminal/session switches, so its renderer is reused.
 */
export function TerminalPane({ terminalId, sessionId }: { terminalId: string; sessionId?: string }) {
  const hostRef = useRef<TerminalHostHandle>(null);
  const [rendererKind, setRendererKind] = useState<RendererKind | null>(null);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const focusSeq = useUiStore((s) => s.terminalFocusSeq);
  // A request to focus the content pane (e.g. the side panel hid) means the terminal here.
  const contentFocusSeq = useUiStore((s) => s.contentFocusSeq);

  // What the last run of the focus effect saw: a run for a new terminal alone (a thread
  // switched terminals, e.g. on reconnect) leaves a keyboard that is in the bottom panel there.
  const seen = useRef({ focusSeq, contentFocusSeq });
  useEffect(() => {
    const asked = seen.current.focusSeq !== focusSeq || seen.current.contentFocusSeq !== contentFocusSeq;
    seen.current = { focusSeq, contentFocusSeq };
    if (!asked && useUiStore.getState().focus === "bottom") return;
    // Hidden under an expanded side panel: the panel is what shows, so it takes the focus
    // meant for the terminal (selection switch, settings closing).
    const panel = getPanel();
    if (panel.open && panel.expanded) {
      useUiStore.setState((s) => ({ panelFocusSeq: s.panelFocusSeq + 1 }));
      return;
    }
    hostRef.current?.focus();
  }, [focusSeq, contentFocusSeq, terminalId]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={sessionId ? "Thread" : "Terminal"} data-session-id={sessionId}>
      <TerminalHeader id={terminalId} sessionId={sessionId} size={size} renderer={rendererKind} />
      <TerminalHost ref={hostRef} name="main" terminalId={terminalId} region="terminal" testId="terminal-host" onSize={setSize} onRenderer={setRendererKind}>
        {sessionId && <SessionIndicator id={sessionId} />}
      </TerminalHost>
    </section>
  );
}
