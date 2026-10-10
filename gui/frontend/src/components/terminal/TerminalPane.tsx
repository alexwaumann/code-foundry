import { useEffect, useRef, useState } from "react";
import { CircleX, GitFork, GitPullRequest, Layers, Loader2, OctagonX, Pencil, Power, RefreshCw } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { PaneHeader } from "@/components/window/PaneHeader";
import { invalidateOnTransportError } from "@/api/endpoint";
import { SessionIndicator, SessionTitle } from "@/components/session/SessionParts";
import { attachTerminal, resizeTerminal, writeTerminal } from "@/api/terminal";
import { isGlobalChord } from "@/keys/bindings";
import { useColorScheme } from "@/lib/theme";
import { useScrollbackLines, useTerminalFontFamily } from "@/stores/settings";
import { tildify, terminalLabel } from "@/lib/path";
import { getPanel } from "@/stores/panel";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { AttachController, type AttachState } from "@/terminal/attach";
import { XtermRenderer, type RendererKind } from "@/terminal/xterm";

declare global {
  interface Window {
    /** Dev/test hook: the mounted renderer (only in dev builds). */
    __cfTerminal?: { renderer: XtermRenderer; controller: AttachController };
  }
}

/**
 * Dev-only: VITE_SIMULATE_WEBGL_LOSS_MS=<ms> loses the WebGL context that long after mount,
 * to exercise the DOM fallback inside the real WKWebView (`wails3 dev`).
 */
function simulateWebglLoss(host: HTMLElement): () => void {
  const ms = Number((import.meta.env as { VITE_SIMULATE_WEBGL_LOSS_MS?: string }).VITE_SIMULATE_WEBGL_LOSS_MS);
  if (!import.meta.env.DEV || !ms) return () => undefined;
  const t = setTimeout(() => {
    const canvas = host.querySelector<HTMLCanvasElement>(".xterm-screen canvas:not(.xterm-link-layer)");
    canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  }, ms);
  return () => {
    clearTimeout(t);
  };
}

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

/**
 * The pane's own commands, run against the current selection (this pane) exactly as the
 * palette runs them. Each hides when the daemon does not list it as available.
 */
/** view.panel.linked-prs with the thread's link count; only once the thread has linked a pull request. */
function LinkedPrsButton({ sessionId }: { sessionId: string }) {
  const count = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  return <CommandButton command="view.panel.linked-prs" icon={GitPullRequest} count={count} data-testid="pane-linked-prs" />;
}

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

function Overlay({ state }: { state: AttachState }) {
  if (state.phase === "exited") {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center" data-testid="exit-overlay">
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border bg-popover/95 px-3 py-2 text-sm shadow-lg backdrop-blur">
          <CircleX className={state.exitCode === 0 ? "size-4 text-muted-foreground" : "size-4 text-red-400"} />
          <span>
            Process exited with code <span className="font-mono">{state.exitCode ?? "?"}</span>
          </span>
        </div>
      </div>
    );
  }
  if (state.phase === "connecting" || state.phase === "reconnecting") {
    return (
      <div className="pointer-events-none absolute top-3 right-4 flex items-center gap-2 rounded-md border bg-popover/90 px-2.5 py-1 text-xs text-muted-foreground">
        {state.phase === "connecting" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5 animate-spin" />}
        {state.phase === "connecting" ? "Attaching…" : "Reconnecting…"}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background/80" role="alert">
        <div className="rounded-md border bg-popover px-4 py-3 text-sm">
          <p className="font-medium">Cannot attach to terminal</p>
          <p className="mt-1 text-muted-foreground">{state.error}</p>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * Hosts the one attached terminal. A single renderer lives as long as the pane; switching
 * terminals (or sessions, or a session's terminal after Reconnect) aborts the old Attach
 * stream and resets the renderer before the new snapshot.
 */
export function TerminalPane({ terminalId, sessionId }: { terminalId: string; sessionId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<{ renderer: XtermRenderer; controller: AttachController } | null>(null);
  const [state, setState] = useState<AttachState>({ terminalId: null, phase: "idle", exitCode: null, error: null });
  const [rendererKind, setRendererKind] = useState<RendererKind | null>(null);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const scheme = useColorScheme();
  const fontSize = useUiStore((s) => s.fontSize);
  const fontFamily = useTerminalFontFamily();
  const scrollback = useScrollbackLines();
  const focusSeq = useUiStore((s) => s.terminalFocusSeq);
  // A request to focus the content pane (e.g. the side panel hid) means the terminal here.
  const contentFocusSeq = useUiStore((s) => s.contentFocusSeq);

  // Renderer + controller live for the pane's lifetime.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ui = useUiStore.getState();
    const renderer = new XtermRenderer({
      fontSize: ui.fontSize,
      colorScheme: scheme,
      isGlobalChord,
      onRendererChange: setRendererKind,
    });
    renderer.mount(host);
    const controller = new AttachController(
      renderer,
      {
        attach: (id, signal) => attachTerminal(id, signal),
        write: (id, data) => writeTerminal(id, data),
        resize: (id, cols, rows) => resizeTerminal(id, cols, rows),
        onStreamError: invalidateOnTransportError,
      },
      setState,
    );
    const sizeSub = renderer.term.onResize((s) => {
      setSize({ cols: s.cols, rows: s.rows });
    });
    setSize(renderer.size);
    ctlRef.current = { renderer, controller };
    if (import.meta.env.DEV) window.__cfTerminal = { renderer, controller };

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        renderer.fit();
      });
    });
    ro.observe(host);
    const stopSimulation = simulateWebglLoss(host);
    return () => {
      stopSimulation();
      ro.disconnect();
      cancelAnimationFrame(raf);
      sizeSub.dispose();
      controller.dispose();
      renderer.dispose();
      ctlRef.current = null;
      if (import.meta.env.DEV && window.__cfTerminal?.renderer === renderer) delete window.__cfTerminal;
    };
    // The renderer is created once; scheme/font changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ctlRef.current?.controller.attach(terminalId);
  }, [terminalId]);

  useEffect(() => {
    ctlRef.current?.renderer.setColorScheme(scheme);
  }, [scheme]);

  useEffect(() => {
    ctlRef.current?.renderer.setFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    ctlRef.current?.renderer.setFontFamily(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    ctlRef.current?.renderer.setScrollback(scrollback);
  }, [scrollback]);

  useEffect(() => {
    // Hidden under an expanded side panel: the panel is what shows, so it takes the focus
    // meant for the terminal (selection switch, settings closing).
    const panel = getPanel();
    if (panel.open && panel.expanded) {
      useUiStore.setState((s) => ({ panelFocusSeq: s.panelFocusSeq + 1 }));
      return;
    }
    ctlRef.current?.renderer.focus();
  }, [focusSeq, contentFocusSeq, terminalId]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={sessionId ? "Thread" : "Terminal"} data-session-id={sessionId}>
      <TerminalHeader id={terminalId} sessionId={sessionId} size={size} renderer={rendererKind} />
      <div className="relative min-h-0 flex-1 bg-[var(--terminal-bg)] py-1 pl-2">
        <div
          ref={hostRef}
          className="h-full w-full"
          data-terminal-host
          data-region="terminal"
          data-testid="terminal-host"
          data-renderer={rendererKind ?? undefined}
          data-attach-phase={state.phase}
          data-terminal-id={state.terminalId ?? undefined}
        />
        <Overlay state={state} />
        {sessionId && <SessionIndicator id={sessionId} />}
      </div>
    </section>
  );
}
