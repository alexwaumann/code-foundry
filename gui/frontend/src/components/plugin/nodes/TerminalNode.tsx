import { lazy, Suspense, useRef, useState } from "react";
import { PanelBottom } from "lucide-react";
import { useStreamSlotsStore } from "@/api/streamSlots";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { showPluginTerminal, useInVisibleBottom } from "@/stores/pluginTerminals";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { terminalAutoHeight, useNarrowerThan, useNodeHeight } from "../height";
import { useViewCtx } from "../context";
import { useLeavingViewTab, useLiveSlot, useOnScreen } from "../live";
import { PluginButton } from "../parts";
import type { NodeProps } from "../registry";
import { LivePaused } from "./LivePaused";
import { OwnedGone } from "./OwnedGone";

// Loaded on first use: xterm stays out of what every surface imports.
const TerminalHost = lazy(() => import("@/components/terminal/TerminalHost").then((m) => ({ default: m.TerminalHost })));

/** Below this node width the title bar's buttons drop their labels (those with an icon). */
const NARROW_PX = 400;

/**
 * The plugin's own terminal, inline (docs/notes/plugins-6-thread-terminal.md): a title
 * bar with the plugin's buttons and "Open in bottom panel" (icons only on a narrow node),
 * over the terminal view. Its own Attach only while near the screen, its view tab stays the
 * active one and within the inline budget (components/plugin/live.ts). While the bottom
 * panel on screen shows the terminal, this node says so instead of attaching a second
 * view. A terminal the GUI does not know shows a muted empty state.
 */
export function TerminalNode({ node, data }: NodeProps<"terminal">) {
  const { inert, watchKey } = useViewCtx();
  const ref = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const fontSize = useUiStore((s) => s.fontSize);
  const height = useNodeHeight(ref, data.height, terminalAutoHeight(data.rows, fontSize));
  const known = useTerminalsStore((s) => data.terminalId in s.byId);
  const loaded = useTerminalsStore((s) => s.loaded);
  const exited = useTerminalsStore((s) => s.byId[data.terminalId]?.state === "exited");
  const inBottom = useInVisibleBottom(data.terminalId);
  const narrow = useNarrowerThan(box, NARROW_PX);
  const onScreen = useOnScreen(el);
  const leaving = useLeavingViewTab(watchKey);
  const wanted = known && onScreen && !leaving && !inBottom;
  const slot = useLiveSlot(`terminal\u0000${watchKey}\u0000${node.key}`, wanted);
  const attached = wanted && slot.live;
  const waiting = useStreamSlotsStore((s) => attached && s.waiting.includes(`terminal:${data.terminalId}`));
  if (!known) {
    return (
      <OwnedGone
        kind="terminal"
        testId="plugin-terminal-gone"
        heading={loaded ? "This terminal is gone" : "Loading the terminal…"}
        detail={loaded ? "It was closed, or ended with the daemon." : (data.title ?? `Terminal ${data.terminalId}`)}
      />
    );
  }
  const openBottom = (
    <Button
      variant="ghost"
      size={narrow ? "icon-xs" : "xs"}
      className="text-muted-foreground hover:text-foreground"
      disabled={inert || inBottom}
      aria-label={narrow ? "Open in bottom panel" : undefined}
      onClick={() => {
        showPluginTerminal(data.terminalId);
      }}
      data-testid="plugin-terminal-open-bottom"
    >
      <PanelBottom aria-hidden />
      {!narrow && "Open in bottom panel"}
    </Button>
  );
  return (
    <div
      ref={setBox}
      className="isolate flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-pane"
      data-testid="plugin-terminal"
      data-key={node.key}
      data-terminal-id={data.terminalId}
      data-exited={exited || undefined}
      data-narrow={narrow || undefined}
      data-live={attached || undefined}
    >
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border py-1 pr-1 pl-2.5">
        <span className="min-w-0 flex-1 truncate text-caption font-medium">{data.title || "Terminal"}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {data.actions?.map((b) => (
            <PluginButton key={b.key} button={narrow && b.icon ? { ...b, iconOnly: true } : b} />
          ))}
          {/* A disabled button gets no pointer events: the span carries the tooltip. */}
          {narrow ? (
            <Tip label="Open in bottom panel">
              <span className="inline-flex shrink-0">{openBottom}</span>
            </Tip>
          ) : (
            openBottom
          )}
        </span>
      </div>
      <div
        ref={(e) => {
          ref.current = e;
          setEl(e);
        }}
        className="relative flex min-h-0 flex-col"
        style={{ height }}
      >
        {inBottom ? (
          <p className="m-auto px-4 text-center text-caption" data-testid="plugin-terminal-in-bottom">
            Shown in the bottom panel.
          </p>
        ) : attached ? (
          <Suspense fallback={null}>
            <TerminalHost terminalId={data.terminalId} streamPriority="inline" testId="plugin-terminal-host" />
          </Suspense>
        ) : (
          <LivePaused kind="terminal" reason={slot.over ? "budget" : "hidden"} onAttach={slot.take} />
        )}
        {waiting && <LivePaused kind="terminal" reason="connections" />}
      </div>
    </div>
  );
}
