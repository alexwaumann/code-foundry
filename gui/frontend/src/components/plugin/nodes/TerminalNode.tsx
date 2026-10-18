import { lazy, Suspense, useRef } from "react";
import { PanelBottom } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showPluginTerminal, useInVisibleBottom } from "@/stores/pluginTerminals";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { terminalAutoHeight, useNodeHeight } from "../height";
import { useViewCtx } from "../context";
import { PluginButton } from "../parts";
import type { NodeProps } from "../registry";
import { OwnedGone } from "./OwnedGone";

// Loaded on first use: xterm stays out of what every surface imports.
const TerminalHost = lazy(() => import("@/components/terminal/TerminalHost").then((m) => ({ default: m.TerminalHost })));

/**
 * The plugin's own terminal, inline (docs/notes/plugins-6-thread-terminal.md): a title
 * bar with the plugin's buttons and "Open in bottom panel", over the terminal view (its own
 * Attach while on screen). While the bottom panel on screen shows the terminal, this node
 * says so instead of attaching a second view. A terminal the GUI does not know shows a
 * muted empty state.
 */
export function TerminalNode({ node, data }: NodeProps<"terminal">) {
  const { inert } = useViewCtx();
  const ref = useRef<HTMLDivElement>(null);
  const fontSize = useUiStore((s) => s.fontSize);
  const height = useNodeHeight(ref, data.height, terminalAutoHeight(data.rows, fontSize));
  const known = useTerminalsStore((s) => data.terminalId in s.byId);
  const loaded = useTerminalsStore((s) => s.loaded);
  const exited = useTerminalsStore((s) => s.byId[data.terminalId]?.state === "exited");
  const inBottom = useInVisibleBottom(data.terminalId);
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
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-pane" data-testid="plugin-terminal" data-key={node.key} data-terminal-id={data.terminalId} data-exited={exited || undefined}>
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border py-1 pr-1 pl-2.5">
        <span className="min-w-0 flex-1 truncate text-caption font-medium">{data.title || "Terminal"}</span>
        {data.actions?.map((b) => (
          <PluginButton key={b.key} button={b} />
        ))}
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground"
          disabled={inert || inBottom}
          onClick={() => {
            showPluginTerminal(data.terminalId);
          }}
          data-testid="plugin-terminal-open-bottom"
        >
          <PanelBottom aria-hidden />
          Open in bottom panel
        </Button>
      </div>
      <div ref={ref} className="flex min-h-0 flex-col" style={{ height }}>
        {inBottom ? (
          <p className="m-auto px-4 text-center text-caption" data-testid="plugin-terminal-in-bottom">
            Shown in the bottom panel.
          </p>
        ) : (
          <Suspense fallback={null}>
            <TerminalHost terminalId={data.terminalId} testId="plugin-terminal-host" />
          </Suspense>
        )}
      </div>
    </div>
  );
}
