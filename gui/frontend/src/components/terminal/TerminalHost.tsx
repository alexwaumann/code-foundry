import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { CircleX, Loader2, RefreshCw } from "lucide-react";
import { invalidateOnTransportError } from "@/api/endpoint";
import type { StreamPriority } from "@/api/streamSlots";
import { attachTerminal, resizeTerminal, writeTerminal } from "@/api/terminal";
import { isGlobalChord } from "@/keys/bindings";
import { cn } from "@/lib/utils";
import { useScrollbackLines, useTerminalFontFamily } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { AttachController, type AttachState } from "@/terminal/attach";
import { XtermRenderer, type RendererKind } from "@/terminal/xterm";

interface DevHook {
  renderer: XtermRenderer;
  controller: AttachController;
}

declare global {
  interface Window {
    /**
     * Dev/test hook: the mounted host's renderer and controller (only in dev builds). The
     * bottom panel's is the only host, so this is its active shell; e2e reads its buffer
     * (e2e/fixtures.ts terminalText) and loses its WebGL context.
     */
    __cfTerminal?: DevHook;
  }
}

export interface TerminalHostHandle {
  focus: () => void;
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

function Overlay({ state }: { state: AttachState }) {
  if (state.phase === "exited") {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center" data-testid="exit-overlay">
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border bg-popover/95 px-3 py-2 text-body shadow-lg backdrop-blur">
          <CircleX className={state.exitCode === 0 ? "size-4 text-muted-foreground" : "size-4 text-destructive"} />
          <span>
            Process exited with code <span className="font-mono">{state.exitCode ?? "?"}</span>
          </span>
        </div>
      </div>
    );
  }
  if (state.phase === "connecting" || state.phase === "reconnecting") {
    return (
      <div className="pointer-events-none absolute top-3 right-4 flex items-center gap-2 rounded-md border bg-popover/90 px-2.5 py-1 text-caption">
        {state.phase === "connecting" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5 animate-spin" />}
        {state.phase === "connecting" ? "Attaching…" : "Reconnecting…"}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background/80" role="alert">
        <div className="rounded-md border bg-popover px-4 py-3 text-body">
          <p className="font-medium">Cannot attach to terminal</p>
          <p className="mt-1 text-muted-foreground">{state.error}</p>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * One xterm attached to at most one terminal: the bottom panel's active shell
 * (components/bottom; threads have no terminal). The renderer lives as long as the host;
 * switching `terminalId` aborts the old Attach stream and resets the renderer before the
 * new snapshot, and a null id detaches (no stream). Resizes refit through a
 * ResizeObserver, and the fit skips a hidden (zero-size) host (terminal/xterm.ts).
 *
 * Focus is the parent's call (`ref.focus()`). The host's focus counts for the region
 * around it (the bottom panel's "bottom").
 */
export function TerminalHost({
  ref,
  terminalId,
  hidden = false,
  exitOverlay = true,
  streamPriority = "core",
  testId,
}: {
  ref?: Ref<TerminalHostHandle>;
  terminalId: string | null;
  hidden?: boolean;
  /** Show "Process exited with code N" over an exited terminal (an action tab has its status line instead). */
  exitOverlay?: boolean;
  /** The Attach stream's priority (api/streamSlots.ts): "inline" in a plugin's terminal node. Read once, at mount. */
  streamPriority?: StreamPriority;
  testId: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<DevHook | null>(null);
  const [state, setState] = useState<AttachState>({ terminalId: null, phase: "idle", exitCode: null, error: null });
  const [rendererKind, setRendererKind] = useState<RendererKind | null>(null);
  // The page zoom (lib/zoom.ts) is undone on the terminal host and applied to the font
  // size instead: xterm's WebGL canvas is sized from devicePixelRatio, which CSS zoom
  // does not change, so a zoomed canvas would be resampled and blurry.
  const zoom = useUiStore((s) => s.zoom);
  const fontSize = useUiStore((s) => Math.round((s.fontSize * s.zoom) / 100));
  const fontFamily = useTerminalFontFamily();
  const scrollback = useScrollbackLines();

  // Set when a renderer is disposed while it has focus: the next one takes it. Only
  // StrictMode's effect replay (dev) creates a second renderer in one host's life, right
  // after the parent may have focused the first.
  const refocus = useRef(false);
  const priority = useRef(streamPriority);

  useImperativeHandle(ref, () => ({ focus: () => ctlRef.current?.renderer.focus() }), []);

  // Renderer + controller live for the host's lifetime.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ui = useUiStore.getState();
    const renderer = new XtermRenderer({
      fontSize: Math.round((ui.fontSize * ui.zoom) / 100),
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
        priority: priority.current,
      },
      setState,
    );
    const hook = { renderer, controller };
    ctlRef.current = hook;
    if (import.meta.env.DEV) window.__cfTerminal = hook;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        renderer.fit();
      });
    });
    ro.observe(host);
    const stopSimulation = simulateWebglLoss(host);
    if (refocus.current) {
      refocus.current = false;
      renderer.focus();
    }
    return () => {
      refocus.current = host.contains(document.activeElement);
      stopSimulation();
      ro.disconnect();
      cancelAnimationFrame(raf);
      controller.dispose();
      renderer.dispose();
      ctlRef.current = null;
      if (import.meta.env.DEV && window.__cfTerminal === hook) delete window.__cfTerminal;
    };
    // The renderer is created once; font changes are applied by the effects below, and the
    // palette follows the document's CSS variables itself (terminal/theme.ts).
  }, []);

  useEffect(() => {
    const ctl = ctlRef.current?.controller;
    if (!ctl) return;
    if (terminalId === null) ctl.detach();
    else ctl.attach(terminalId);
  }, [terminalId]);

  useEffect(() => {
    ctlRef.current?.renderer.setFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    ctlRef.current?.renderer.setFontFamily(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    ctlRef.current?.renderer.setScrollback(scrollback);
  }, [scrollback]);

  return (
    <div className={cn("relative min-h-0 flex-1 bg-pane py-1 pl-2", hidden && "hidden")}>
      <div
        ref={hostRef}
        className="h-full w-full"
        style={{ zoom: 100 / zoom }}
        data-terminal-host
        data-testid={testId}
        data-renderer={rendererKind ?? undefined}
        data-attach-phase={state.phase}
        data-terminal-id={state.terminalId ?? undefined}
      />
      {(exitOverlay || state.phase !== "exited") && <Overlay state={state} />}
    </div>
  );
}
