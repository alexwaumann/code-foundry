import { useEffect } from "react";
import { ArrowUpCircle, Download, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { SectionCard } from "@/components/settings/SectionCard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { installPlugin, loadBrowse, updatePlugin, usePluginRegistryStore } from "@/stores/pluginRegistry";
import { PillView } from "../parts";
import { entryPill, progressWords, registryErrorWords, registryLine, shortSource } from "./registry";

/** The amber-outlined main action of a row (no filled buttons). */
export const mainAction = "bg-transparent dark:bg-transparent border-warning/40 text-warning hover:bg-warning/10 hover:text-warning dark:border-warning/40";

/** An install in progress, or the last one's failure, under a row. */
function Progress({ name }: { name: string }) {
  const p = usePluginRegistryStore((s) => s.progress[name]);
  if (!p) return null;
  const failed = p.phase === "failed";
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-caption-sm", failed ? "break-words text-destructive" : "text-muted-foreground")} data-testid="registry-progress" data-phase={p.phase} role={failed ? "alert" : "status"}>
      {!failed && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
      <span className="min-w-0">{progressWords(p)}</span>
    </p>
  );
}

/** One registry entry: who it is, what it asks for, where it comes from, and install or update. */
function EntryRow({ name, className }: { name: string; className?: string | undefined }) {
  const e = usePluginRegistryStore((s) => s.browse?.entries.find((x) => x.name === name));
  const busy = usePluginRegistryStore((s) => s.busy[name]);
  if (!e) return null;
  const pill = entryPill(e);
  const installed = e.installedVersion !== null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 px-4 py-3", className)} data-testid="registry-entry" data-plugin={e.name}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-label">{e.displayName}</span>
          <span className="shrink-0 font-mono text-caption-sm">{e.version}</span>
          <PillView pill={pill} className="ml-auto" />
        </div>
        {e.description && <p className="line-clamp-2 text-caption">{e.description}</p>}
        <p className="text-caption-sm break-words" data-testid="registry-permissions">
          {e.permissionLines.length === 0 ? "Asks for no permissions." : `May ${e.permissionLines.join("; ")}.`}
        </p>
        <p className="truncate font-mono text-caption-sm">
          {e.repo ? `${e.repo} · ` : ""}from {shortSource(e.registry)}
        </p>
        <Progress name={e.name} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {!installed && (
          <Button
            variant="outline"
            size="xs"
            className={mainAction}
            disabled={!e.available || busy !== undefined}
            onClick={() => void installPlugin(e.name)}
            data-testid="registry-install"
          >
            {busy === "install" ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            Install
          </Button>
        )}
        {installed && e.updateAvailable && !e.installedDev && (
          <Button variant="outline" size="xs" className={mainAction} disabled={busy !== undefined} onClick={() => void updatePlugin(e.name)} data-testid="registry-update">
            {busy === "update" ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUpCircle aria-hidden />}
            Update to {e.version}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A registry that failed, or has nothing to list yet. */
function RegistryNotices() {
  const registries = usePluginRegistryStore((s) => s.browse?.registries);
  if (!registries) return null;
  if (registries.length === 0)
    return (
      <p className="border-t border-border px-4 py-3 text-caption" data-testid="registry-none">
        No registries: add one below.
      </p>
    );
  return (
    <>
      {registries.map((r) => (
        <div key={r.url} className="flex min-w-0 flex-col gap-0.5 border-t border-border px-4 py-2.5" data-testid="registry-status" data-error={r.error ? "true" : undefined}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-caption-sm text-foreground">{shortSource(r.url)}</span>
            <span className="ml-auto shrink-0 text-caption-sm">{registryLine(r)}</span>
          </div>
          {r.error && (
            <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-warning" role="alert">
              <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {registryErrorWords(r.error)}
                {r.cached ? " Showing what it listed last time." : ""}
              </span>
            </p>
          )}
          {r.issues.map((i) => (
            <p key={i} className="text-caption-sm break-words text-warning">
              {i}
            </p>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * Settings → Plugins → Browse: every registry's plugins (the first registry listing a name
 * wins), what each asks for, and Install (download, check, install, then the consent
 * dialog) or Update; each registry's state below. Read from the daemon's cache (an hour)
 * unless refreshed.
 */
export function BrowseSection() {
  const names = usePluginRegistryStore(useShallow((s) => s.browse?.entries.map((e) => e.name) ?? []));
  const loaded = usePluginRegistryStore((s) => s.browse !== null);
  const loading = usePluginRegistryStore((s) => s.loading);
  const error = usePluginRegistryStore((s) => s.error);
  useEffect(() => {
    void loadBrowse();
  }, []);
  return (
    <SectionCard id="browse" heading="Browse" description="Plugins the registries list. Installing asks for your consent before anything runs.">
      <div className="flex min-w-0 items-center gap-2 px-4 py-2" data-testid="plugins-browse">
        <span className="min-w-0 truncate text-caption">{loaded ? `${String(names.length)} ${names.length === 1 ? "plugin" : "plugins"}` : "Reading the registries…"}</span>
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground hover:text-foreground" disabled={loading} onClick={() => void loadBrowse(true)} data-testid="registry-refresh">
          <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      </div>
      {error && (
        <p className="border-t border-border px-4 py-3 text-caption break-words text-destructive" role="alert" data-testid="registry-error">
          {error}
        </p>
      )}
      {names.map((n) => (
        <EntryRow key={n} name={n} className="border-t border-border" />
      ))}
      {loaded && names.length === 0 && !error && (
        <p className="border-t border-border px-4 py-3 text-caption" data-testid="registry-empty">
          No plugins listed yet.
        </p>
      )}
      <RegistryNotices />
    </SectionCard>
  );
}
