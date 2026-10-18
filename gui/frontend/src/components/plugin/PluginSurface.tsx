import { useEffect, useMemo, type ReactNode } from "react";
import { CircleAlert, Puzzle, RotateCcw, TriangleAlert } from "lucide-react";
import type { PluginStateView } from "@/api/plugin";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { retitlePanelTab, useCurrentPanelKey, type Tab } from "@/stores/panel";
import { surfaceManifestOf, usePluginsStore } from "@/stores/plugins";
import { startSurfaceWatch, useSurfaceEntry, watchKeyOf } from "@/stores/pluginSurfaces";
import { useUiStore } from "@/stores/ui";
import { useShowState } from "@/surfaces/plugin";
import { ViewContext, type ViewCtx } from "./context";
import { SurfaceHeader } from "./Header";
import { NodeList } from "./NodeList";
import { ViewTabsBar } from "./ViewTabsBar";

/** The plugin and surface ids a kind names (plugin.<plugin>.<surface>). */
function parseKind(kind: string): { plugin: string; surface: string } {
  const m = /^plugin\.([^.]+)\.(.+)$/.exec(kind);
  return { plugin: m?.[1] ?? "", surface: m?.[2] ?? "" };
}

/** A host-made state above the view (or in place of it): the MCP card box with a tone border. */
function StateNotice({ tone, heading, children, action, testId }: { tone: "attention" | "error" | "neutral"; heading: string; children?: ReactNode; action?: ReactNode; testId: string }) {
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div
      className={cn("mx-4 mt-3 flex min-w-0 flex-col gap-1 rounded-lg border px-3 pt-2.5 pb-2 @max-[340px]:mx-3", tone === "error" ? "border-destructive/35" : tone === "attention" ? "border-warning/35" : "border-border")}
      role="status"
      data-testid={testId}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone === "error" ? "text-destructive" : tone === "attention" ? "text-warning" : "text-muted-foreground")} aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className={cn("text-body-sm font-semibold", tone === "error" ? "text-destructive" : tone === "attention" ? "text-warning" : "")}>{heading}</p>
          {children && <div className="text-caption-sm break-words">{children}</div>}
        </div>
      </div>
      {action && <div className="pl-5.5">{action}</div>}
    </div>
  );
}

function RestartButton({ plugin, label }: { plugin: string; label: string }) {
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => void runCommand("plugin.restart", { name: plugin })} data-testid="plugin-restart">
      <RotateCcw aria-hidden />
      Restart {label}
    </Button>
  );
}

/** The first paint: bars where the body will be. */
function Opening() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid="plugin-opening" aria-busy="true" aria-label="Opening">
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="mt-2 h-6 w-40" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

const downWords: Partial<Record<PluginStateView, string>> = {
  crashed: "crashed",
  failed: "failed",
  disabled: "is disabled",
  starting: "is starting",
  stopping: "is stopping",
  stopped: "is stopped",
};

/**
 * One plugin surface tab (docs/notes/plugins-5-gui.md): holds the instance open while the
 * tab shows (one WatchSurface), and draws its view: the header and the plugin's tabs
 * pinned, the body's nodes scrolling under them, and the host's states around it
 * (opening, not responding, the plugin down with its last view dimmed, failed, not
 * available here).
 */
export function PluginSurface({ tab }: { tab: Tab }) {
  const panelKey = useCurrentPanelKey() ?? "";
  const watchKey = watchKeyOf(panelKey, tab.id);
  const { plugin, surface } = parseKind(tab.kind);
  const loaded = usePluginsStore((s) => s.loaded);
  const title = usePluginsStore((s) => surfaceManifestOf(tab.kind, s)?.title ?? "");
  const icon = usePluginsStore((s) => surfaceManifestOf(tab.kind, s)?.icon ?? "");
  const pluginName = usePluginsStore((s) => s.byName[plugin]?.displayName ?? plugin);
  const known = title !== "" || icon !== "";
  const selection = useUiStore((s) => s.selection);
  const uiContext = useMemo(() => getUiContext(selection), [selection]);
  const ctxKey = contextKey(uiContext);
  const show = useShowState(tab.kind, selection);

  const phase = useSurfaceEntry(watchKey, (e) => e?.phase ?? "connecting");
  const message = useSurfaceEntry(watchKey, (e) => e?.message ?? "");
  const pluginState = useSurfaceEntry(watchKey, (e) => e?.pluginState ?? "unknown");
  const view = useSurfaceEntry(watchKey, (e) => e?.view ?? null);
  const version = useSurfaceEntry(watchKey, (e) => e?.version ?? 0);
  const instance = useSurfaceEntry(watchKey, (e) => e?.instance ?? "");
  const hostRendered = useSurfaceEntry(watchKey, (e) => e?.hostRendered ?? false);
  const error = useSurfaceEntry(watchKey, (e) => e?.error ?? null);

  // One stream while the tab shows and the surface may show here.
  const watching = known && show !== "unavailable";
  useEffect(() => {
    if (!watching) return;
    return startSurfaceWatch(watchKey, { plugin, surface, context: uiContext });
    // uiContext follows ctxKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, watchKey, plugin, surface, ctxKey]);

  // The view's tab title names the tab in the strip.
  const tabTitle = view?.header?.tabTitle ?? "";
  useEffect(() => {
    if (tabTitle) retitlePanelTab(panelKey, tab.id, tabTitle);
  }, [panelKey, tab.id, tabTitle]);

  const viewTab = view?.tabs?.active ?? "";
  const down = phase === "plugin-down" || phase === "not-responding" || phase === "failed";
  const inert = down || error !== null;
  const ctx = useMemo<ViewCtx>(() => ({ watchKey, instance, version, plugin, viewTab, uiContext, inert }), [watchKey, instance, version, plugin, viewTab, uiContext, inert]);

  if (!loaded) return <Opening />;
  if (!known) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="plugin-missing">
        <Puzzle className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-body-sm font-medium">This surface is gone</p>
        <p className="max-w-64 text-caption">The plugin {plugin} is not installed, or no longer offers {surface}.</p>
      </div>
    );
  }

  let banner: ReactNode = null;
  if (show === "unavailable") {
    banner = (
      <StateNotice tone="neutral" heading="Not available here" testId="plugin-unavailable">
        {title} does not apply to this selection.
      </StateNotice>
    );
  } else if (error !== null && !down) {
    banner = (
      <StateNotice tone="attention" heading={`Cannot reach ${title}`} testId="plugin-stream-error">
        {error}
      </StateNotice>
    );
  } else if (phase === "plugin-down") {
    banner = (
      <StateNotice
        tone={pluginState === "failed" ? "error" : "attention"}
        heading={`${pluginName} ${downWords[pluginState] ?? "is not running"}`}
        testId="plugin-down"
        action={pluginState === "failed" || pluginState === "crashed" ? <RestartButton plugin={plugin} label={pluginName} /> : undefined}
      >
        {message || "Showing the last view it sent."}
      </StateNotice>
    );
  } else if (phase === "not-responding") {
    banner = (
      <StateNotice tone="attention" heading={`${pluginName} is not responding`} testId="plugin-not-responding" action={<RestartButton plugin={plugin} label={pluginName} />}>
        {message || "It has not sent a view."}
      </StateNotice>
    );
  } else if (phase === "failed") {
    banner = (
      <StateNotice tone="error" heading={`${title} could not open`} testId="plugin-failed" action={<RestartButton plugin={plugin} label={pluginName} />}>
        {message}
      </StateNotice>
    );
  }

  return (
    <ViewContext.Provider value={ctx}>
      {/* @container: the header, tabs and rows adapt to the panel's width (down to 280px). */}
      <div
        className="@container flex min-w-0 flex-col pb-4"
        data-testid="plugin-surface"
        data-kind={tab.kind}
        data-phase={phase}
        data-version={version || undefined}
        data-host-rendered={hostRendered || undefined}
      >
        <div className="sticky top-0 z-10 bg-pane">
          <SurfaceHeader header={view?.header} fallbackTitle={title} icon={icon} note={view ? undefined : show === "unavailable" ? undefined : "Loading…"} />
          {view?.tabs && view.tabs.items.length > 0 && <ViewTabsBar tabs={view.tabs} />}
        </div>
        {banner}
        {view ? (
          <div className={cn("px-4 pt-3 @max-[340px]:px-3", down && "opacity-60 [&_.animate-spin]:animate-none")} data-testid="plugin-body" data-stale={down || undefined}>
            <NodeList nodes={view.nodes} />
          </div>
        ) : show !== "unavailable" && !down && error === null ? (
          <Opening />
        ) : null}
      </div>
    </ViewContext.Provider>
  );
}
