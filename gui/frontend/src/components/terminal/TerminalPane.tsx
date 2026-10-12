import { useEffect, useRef, useState } from "react";
import { GitFork, GitPullRequest, Layers, Pencil, Power } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { CommandButton } from "@/components/command/CommandButton";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { PaneHeader } from "@/components/window/PaneHeader";
import { SessionIndicator, SessionTitle } from "@/components/session/SessionParts";
import { getPanel } from "@/stores/panel";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import type { RendererKind } from "@/terminal/xterm";
import { TerminalHost, type TerminalHostHandle } from "./TerminalHost";

/** view.panel.linked-prs with the thread's link count; only once the thread has linked a pull request. */
function LinkedPrsButton({ sessionId }: { sessionId: string }) {
  const count = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  return <CommandButton command="view.panel.linked-prs" icon={GitPullRequest} count={count} data-testid="pane-linked-prs" />;
}

/**
 * The pane's own commands, run against the current selection (this thread) exactly as the
 * palette runs them. Each hides when the daemon does not list it as available.
 */
export function HeaderActions({ sessionId }: { sessionId: string }) {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      <CommandButton command="session.rename" icon={Pencil} />
      <CommandButton command="session.fork" icon={GitFork} />
      <CommandButton command="session.close" icon={Power} />
      <LinkedPrsButton sessionId={sessionId} />
      {/* Only listed for a workspace thread (view.panel.workspace's availability). */}
      <CommandButton command="view.panel.workspace" icon={Layers} data-testid="pane-workspace" />
      <BottomToggle />
      <PanelToggle />
    </span>
  );
}

function TerminalHeader({ sessionId, size, renderer }: { sessionId: string; size: { cols: number; rows: number } | null; renderer: RendererKind | null }) {
  return (
    <PaneHeader className="gap-3 px-3 text-xs" data-testid="terminal-header">
      <SessionTitle id={sessionId} />
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
 * The content pane's terminal: a thread's Claude terminal under a header (the thread's
 * title, the terminal's size, the pane's commands). Shells show in the bottom panel
 * instead (components/bottom). The host stays mounted across thread switches, so its
 * renderer is reused.
 */
export function TerminalPane({ terminalId, sessionId }: { terminalId: string; sessionId: string }) {
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Thread" data-session-id={sessionId}>
      <TerminalHeader sessionId={sessionId} size={size} renderer={rendererKind} />
      <TerminalHost ref={hostRef} name="main" terminalId={terminalId} region="terminal" testId="terminal-host" onSize={setSize} onRenderer={setRendererKind}>
        <SessionIndicator id={sessionId} />
      </TerminalHost>
    </section>
  );
}
