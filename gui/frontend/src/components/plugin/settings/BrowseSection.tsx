import { useEffect } from "react";
import { ArrowUpCircle, Download, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { focusSetting } from "@/components/settings/focus";
import { SectionCard } from "@/components/settings/SectionCard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dismissInstallFailure, installPlugin, loadBrowse, updatePlugin, usePluginRegistryStore } from "@/stores/pluginRegistry";
import { PillView } from "../parts";
import { emptyBrowse, entryAction, entryPill, progressWords, REGISTRIES_SETTING, registryErrorWords, registryLine, shortSource } from "./registry";

/** The amber-outlined main action of a row (no filled buttons). */
export const mainAction = "bg-transparent dark:bg-transparent border-cf-warning/40 text-cf-warning hover:bg-cf-warning-surface hover:text-cf-warning dark:border-cf-warning/40";

/** An install in progress, or the last one's failure (the daemon's words, with a dismiss ×), under a row. */
function Progress({ name }: { name: string }) {
  const p = usePluginRegistryStore((s) => s.progress[name]);
  if (!p) return null;
  const failed = p.phase === "failed";
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-caption-sm", failed ? "break-words text-cf-error" : "text-cf-text-muted")} data-testid="registry-progress" data-phase={p.phase} role={failed ? "alert" : "status"}>
      {!failed && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
      <span className="min-w-0">{progressWords(p)}</span>
      {failed && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto shrink-0 self-start text-cf-text-muted hover:text-cf-text"
          aria-label="Dismiss"
          onClick={() => {
            dismissInstallFailure(name);
          }}
          data-testid="registry-progress-dismiss"
        >
          <X aria-hidden />
        </Button>
      )}
    </p>
  );
}

/** One registry entry: who it is, what it asks for, where it comes from, and install or update. */
function EntryRow({ name, className }: { name: string; className?: string | undefined }) {
  const e = usePluginRegistryStore((s) => s.browse?.entries.find((x) => x.name === name));
  const busy = usePluginRegistryStore((s) => s.busy[name]);
  if (!e) return null;
  const pill = entryPill(e);
  const action = entryAction(e);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 px-4 py-3", className)} data-testid="registry-entry" data-plugin={e.name} data-relation={e.relation}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-label">{e.displayName}</span>
          <span className="shrink-0 font-mono text-caption-sm">{e.version}</span>
          <PillView pill={pill} className={cn("ml-auto", e.relation === "other-source" && "max-w-1/2 truncate")} />
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
      {action !== null && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {action === "install" && (
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
          {action === "update" && (
            <Button variant="outline" size="xs" className={mainAction} disabled={busy !== undefined} onClick={() => void updatePlugin(e.name)} data-testid="registry-update">
              {busy === "update" ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUpCircle aria-hidden />}
              Update to {e.version}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Each configured registry: when it was read, and a failure in words. */
function RegistryNotices() {
  const registries = usePluginRegistryStore((s) => s.browse?.registries);
  if (!registries || registries.length === 0) return null;
  return (
    <>
      {registries.map((r) => (
        <div key={r.url} className="flex min-w-0 flex-col gap-0.5 border-t border-cf-border px-4 py-2.5" data-testid="registry-status" data-error={r.error ? "true" : undefined}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-caption-sm text-cf-text">{shortSource(r.url)}</span>
            <span className="ml-auto shrink-0 text-caption-sm">{registryLine(r)}</span>
          </div>
          {r.error && (
            <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-cf-warning" role="alert">
              <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {registryErrorWords(r.error)}
                {r.cached ? " Showing what it listed last time." : ""}
              </span>
            </p>
          )}
          {r.issues.map((i) => (
            <p key={i} className="text-caption-sm break-words text-cf-warning">
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
  const empty = usePluginRegistryStore((s) => emptyBrowse(s.browse, s.error));
  useEffect(() => {
    void loadBrowse();
  }, []);
  return (
    <SectionCard id="browse" heading="Browse" description="Plugins the registries list. Installing asks for your consent before anything runs.">
      <div className="flex min-w-0 items-center gap-2 px-4 py-2" data-testid="plugins-browse">
        <span className="min-w-0 truncate text-caption">{loaded ? `${String(names.length)} ${names.length === 1 ? "plugin" : "plugins"}` : "Reading the registries…"}</span>
        <Button variant="ghost" size="xs" className="ml-auto text-cf-text-muted hover:text-cf-text" disabled={loading} onClick={() => void loadBrowse(true)} data-testid="registry-refresh">
          <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      </div>
      {error && (
        <p className="border-t border-cf-border px-4 py-3 text-caption break-words text-cf-error" role="alert" data-testid="registry-error">
          {error}
        </p>
      )}
      {names.map((n) => (
        <EntryRow key={n} name={n} className="border-t border-cf-border" />
      ))}
      {empty === "no-registry" && (
        <p className="border-t border-cf-border px-4 py-3 text-caption" data-testid="registry-none">
          No registry configured.{" "}
          <button
            type="button"
            className="text-link hover:underline"
            onClick={() => {
              focusSetting(REGISTRIES_SETTING);
            }}
            data-testid="registry-none-link"
          >
            Add one in Registries
          </button>
        </p>
      )}
      {empty === "none-listed" && (
        <p className="border-t border-cf-border px-4 py-3 text-caption" data-testid="registry-empty">
          No plugins listed yet.
        </p>
      )}
      <RegistryNotices />
    </SectionCard>
  );
}
