import { lazy, Suspense, useRef, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { showPluginTerminal, useTerminalShown } from "@/stores/pluginTerminals";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { terminalAutoHeight, useNarrowerThan, useNodeHeight } from "../height";
import { useViewCtx } from "../context";
import { useOnScreen, useRepeated } from "../live";
import { PluginButton } from "../parts";
import type { NodeProps } from "../registry";
import { LiveHidden } from "./LiveHidden";
import { OwnedGone } from "./OwnedGone";
import { ShownAbove } from "./ShownAbove";

// Loaded on first use: xterm stays out of what every surface imports.
const TerminalHost = lazy(() => import("@/components/terminal/TerminalHost").then((m) => ({ default: m.TerminalHost })));

/** Below this node width the title bar's buttons drop their labels (those with an icon). */
const NARROW_PX = 400;

/**
 * The plugin's own terminal, inline (docs/notes/plugins-6-thread-terminal.md): a title
 * bar with the plugin's buttons and "Open in a tab" (icons only on a narrow node), over the
 * terminal view. Its own Attach only while near the screen (components/plugin/live.ts). While a
 * tab on screen shows the terminal, this node says so instead of attaching a second view, and a later node naming the same terminal
 * in the view says "Shown above" for the same reason. A terminal the GUI does not know shows
 * a muted empty state.
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
  const inTab = useTerminalShown(data.terminalId);
  const narrow = useNarrowerThan(box, NARROW_PX);
  const onScreen = useOnScreen(el);
  const repeated = useRepeated(watchKey, data.terminalId, box);
  const attached = known && onScreen && !inTab && !repeated;
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
  const openTab = (
    <Button
      variant="ghost"
      size={narrow ? "icon-xs" : "xs"}
      className="text-cf-text-muted hover:text-cf-text"
      disabled={inert || inTab}
      aria-label={narrow ? "Open in a tab" : undefined}
      onClick={() => {
        void showPluginTerminal(data.terminalId);
      }}
      data-testid="plugin-terminal-open-tab"
    >
      <SquareTerminal aria-hidden />
      {!narrow && "Open in a tab"}
    </Button>
  );
  return (
    <div
      ref={setBox}
      className="isolate flex min-w-0 flex-col overflow-hidden rounded-lg border border-cf-border bg-cf-surface"
      data-testid="plugin-terminal"
      data-key={node.key}
      data-terminal-id={data.terminalId}
      data-exited={exited || undefined}
      data-narrow={narrow || undefined}
      data-live={attached || undefined}
      data-repeated={repeated || undefined}
    >
      {!repeated && (
        <div className="flex min-w-0 items-center gap-1.5 border-b border-cf-border py-1 pr-1 pl-2.5">
          <Tip label={data.title} whenTruncated>
            <span className="min-w-0 flex-1 truncate text-caption font-medium">{data.title || "Terminal"}</span>
          </Tip>
          <span className="flex shrink-0 items-center gap-0.5">
            {data.actions?.map((b) => (
              <PluginButton key={b.key} button={narrow && b.icon ? { ...b, iconOnly: true } : b} />
            ))}
            {/* A disabled button gets no pointer events: the span carries the tooltip. */}
            {narrow ? (
              <Tip label="Open in a tab">
                <span className="inline-flex shrink-0">{openTab}</span>
              </Tip>
            ) : (
              openTab
            )}
          </span>
        </div>
      )}
      <div
        ref={(e) => {
          ref.current = e;
          setEl(e);
        }}
        className={cn("relative flex min-h-0 flex-col", repeated && "grow")}
        style={repeated ? undefined : { height }}
      >
        {inTab ? (
          <p className="m-auto px-4 text-center text-caption" data-testid="plugin-terminal-in-tab">
            Shown in a tab.
          </p>
        ) : repeated ? (
          <ShownAbove />
        ) : attached ? (
          <Suspense fallback={null}>
            <TerminalHost terminalId={data.terminalId} testId="plugin-terminal-host" />
          </Suspense>
        ) : (
          <LiveHidden />
        )}
      </div>
    </div>
  );
}
