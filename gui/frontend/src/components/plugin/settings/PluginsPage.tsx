import { useEffect, useState } from "react";
import { ArrowUpCircle, FolderPlus, Loader2, Logs, PanelRight, Power, PowerOff, RotateCcw, Trash2 } from "lucide-react";
import { pluginEnvironments, type PluginEnvironmentView, type PluginView } from "@/api/plugin";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { pageSections } from "@/components/settings/model";
import { PageHead } from "@/components/settings/PageHead";
import { SectionCard, SettingsSection } from "@/components/settings/SectionCard";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { startCommandNamed } from "@/keys/bindings";
import { runCommand, useCommandsStore } from "@/stores/commands";
import { updatePlugin, usePluginRegistryStore } from "@/stores/pluginRegistry";
import { loadPluginDirs, usePlugin, usePluginNames, usePluginsStore } from "@/stores/plugins";
import { useProjectsStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
import { PillView, PluginIcon } from "../parts";
import { BrowseSection, mainAction } from "./BrowseSection";
import { pluginsDirWords } from "./dirs";
import { LogsDialog } from "./LogsDialog";
import { SecretsList, SecretsToggle } from "./SecretsSection";
import { UninstallDialog } from "./UninstallDialog";
import { keepsSecrets, processLine, scopeWords, statePill } from "./state";

/** Every plugin's contribution to new threads, re-read when a plugin changes. */
function useEnvironments(): Readonly<Record<string, PluginEnvironmentView>> {
  const plugins = usePluginsStore((s) => s.byName);
  const [envs, setEnvs] = useState<Readonly<Record<string, PluginEnvironmentView>>>({});
  useEffect(() => {
    const ctl = new AbortController();
    pluginEnvironments(ctl.signal)
      .then((list) => {
        setEnvs(Object.fromEntries(list.map((e) => [e.plugin, e])));
      })
      .catch(() => undefined);
    return () => {
      ctl.abort();
    };
  }, [plugins]);
  return envs;
}

/** What a plugin adds to new threads: env, PATH, add-dirs, who gets it; running threads keep what they spawned with. */
function EnvSummary({ env }: { env: PluginEnvironmentView }) {
  const projects = useProjectsStore((s) => s.byId);
  const projectName = (id: string) => projects[id]?.name ?? id;
  const empty = env.env.length === 0 && env.pathPrepend.length === 0 && env.addDirs.length === 0;
  if (empty && env.issues.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2" data-testid="plugin-env">
      <p className="text-caption-sm">New threads in {scopeWords(env.projects, env.noProject, projectName)} get:</p>
      <ul className="flex min-w-0 flex-col gap-0.5 font-mono text-caption-sm text-foreground">
        {env.env.map((k) => (
          <li key={k} className="truncate">
            {k}
          </li>
        ))}
        {env.pathPrepend.map((p) => (
          <li key={`path:${p}`} className="truncate">
            PATH += {p}
          </li>
        ))}
        {env.addDirs.map((d) => (
          <li key={`dir:${d}`} className="truncate">
            --add-dir {d}
          </li>
        ))}
      </ul>
      {env.issues.map((i) => (
        <p key={i} className="text-caption-sm text-warning">
          {i}
        </p>
      ))}
      <p className="text-caption-sm">New threads get this; running threads keep what they spawned with.</p>
    </div>
  );
}

/** "Open <surface>" for each of a plugin's surfaces: its show command, available or not for the current selection. */
function SurfaceButtons({ p }: { p: PluginView }) {
  const available = useCommandsStore((s) => s.commands.filter((c) => c.available && c.name.startsWith(`plugin.${p.name}.show.`)).map((c) => c.name).join(","));
  if (p.surfaces.length === 0 || !p.enabled) return null;
  const on = new Set(available.split(","));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {p.surfaces.map((s) => {
        const ok = on.has(s.showCommand);
        const button = (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            disabled={!ok}
            onClick={() => {
              startCommandNamed(s.showCommand);
            }}
            data-testid="plugin-open-surface"
            data-surface={s.kind}
          >
            <PanelRight aria-hidden />
            Open {s.title}
          </Button>
        );
        return ok ? (
          <span key={s.id}>{button}</span>
        ) : (
          <Tip key={s.id} label="Not available for what is selected">
            <span className="inline-flex">{button}</span>
          </Tip>
        );
      })}
    </div>
  );
}

/** One installed plugin: identity, state, the process, problems, its surfaces and what it adds to new threads; the actions. */
function PluginRow({
  name,
  env,
  className,
  onLogs,
  onUninstall,
}: {
  name: string;
  env: PluginEnvironmentView | undefined;
  className?: string | undefined;
  onLogs: (name: string) => void;
  onUninstall: (name: string) => void;
}) {
  const p = usePlugin(name);
  const busy = usePluginRegistryStore((s) => s.busy[name]);
  const [secretsOpen, setSecretsOpen] = useState(false);
  if (!p) return null;
  const secrets = keepsSecrets(p);
  const pill = statePill(p);
  const proc = processLine(p);
  const update = p.updateAvailable && !p.dev;
  const main = !p.enabled && !update;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 px-4 py-3", className)} data-testid="plugin-row-settings" data-plugin={p.name} data-state={p.state}>
      <div className="flex min-w-0 items-start gap-3">
        <PluginIcon name={p.surfaces[0]?.icon} fallback="puzzle" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-label">{p.displayName}</span>
            <span className="shrink-0 font-mono text-caption-sm">{p.version}</span>
            {p.dev && <span className="shrink-0 rounded-sm border border-border px-1 text-caption-sm">dev</span>}
            <PillView pill={pill} className="ml-auto" />
          </div>
          {p.description && <p className="line-clamp-2 text-caption">{p.description}</p>}
          {proc && (
            <p className="text-caption-sm tabular-nums" data-testid="plugin-process">
              {proc}
            </p>
          )}
          {p.disabledReason && <p className="text-caption-sm text-warning">{p.disabledReason}</p>}
          {p.lastError && p.state !== "running" && (
            <p className="font-mono text-caption-sm break-words text-destructive" data-testid="plugin-last-error">
              {p.lastError}
            </p>
          )}
          {p.issues.map((i) => (
            <p key={i} className="text-caption-sm text-warning">
              {i}
            </p>
          ))}
          {p.dev && p.devPath && <p className="truncate font-mono text-caption-sm">{p.devPath}</p>}
          {!p.dev && p.install && (
            <p className="truncate font-mono text-caption-sm" data-testid="plugin-installed-from">
              from {p.install.source.replace(/^https?:\/\/(github\.com\/)?/, "")}
            </p>
          )}
          {update && (
            <p className="text-caption-sm text-warning" data-testid="plugin-update-available">
              {p.updateVersion} is available.
            </p>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2 pl-7">
        <SurfaceButtons p={p} />
        {env && p.enabled && <EnvSummary env={env} />}
        {secrets && secretsOpen && <SecretsList name={p.name} />}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {update && (
            <Button variant="outline" size="xs" className={mainAction} disabled={busy !== undefined} onClick={() => void updatePlugin(p.name)} data-testid="plugin-update">
              {busy === "update" ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUpCircle aria-hidden />}
              Update to {p.updateVersion}
            </Button>
          )}
          {p.enabled ? (
            <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => void runCommand("plugin.disable", { name: p.name })} data-testid="plugin-disable">
              <PowerOff aria-hidden />
              Disable
            </Button>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className={cn("bg-transparent dark:bg-transparent", main && "border-warning/40 text-warning hover:bg-warning/10 hover:text-warning dark:border-warning/40")}
              onClick={() => void runCommand("plugin.enable", { name: p.name })}
              data-testid="plugin-enable"
            >
              <Power aria-hidden />
              Enable
            </Button>
          )}
          {p.enabled && (
            <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => void runCommand("plugin.restart", { name: p.name })} data-testid="plugin-restart-settings">
              <RotateCcw aria-hidden />
              Restart
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              onLogs(p.name);
            }}
            data-testid="plugin-logs-open"
          >
            <Logs aria-hidden />
            Logs
          </Button>
          {secrets && (
            <SecretsToggle
              open={secretsOpen}
              onToggle={() => {
                setSecretsOpen((o) => !o);
              }}
            />
          )}
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            disabled={busy !== undefined}
            onClick={() => {
              onUninstall(p.name);
            }}
            data-testid="plugin-uninstall"
          >
            {busy === "uninstall" ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            Uninstall
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings → Plugins (DECISIONS.md, "Registry"): the installed plugins, each with its
 * state, process, problems, surfaces (open in the panel) and what it adds to new
 * threads, and enable (with the consent dialog), disable, restart, update, uninstall and
 * logs. "Add a dev plugin" runs plugin.dev from the palette (its folder picker). Browse
 * lists the registries' plugins (BrowseSection); the page's settings (plugins.registries)
 * follow it.
 */
export function PluginsPage({ schema, page }: { schema: SettingsSchemaView; page: SettingPageView }) {
  const names = usePluginNames();
  const loaded = usePluginsStore((s) => s.loaded);
  const envs = useEnvironments();
  const [logsOf, setLogsOf] = useState<string | null>(null);
  const [uninstallOf, setUninstallOf] = useState<string | null>(null);
  const logsTitle = usePluginsStore((s) => (logsOf ? (s.byName[logsOf]?.displayName ?? logsOf) : ""));
  const dir = usePluginsStore((s) => pluginsDirWords(s.dirs));
  useEffect(() => {
    void loadPluginDirs();
  }, []);
  return (
    <>
      <PageHead
        page={page}
        aside={
          <Button variant="outline" size="xs" onClick={() => {
              useUiStore.getState().openPalette("", "plugin.dev");
            }} data-testid="plugin-dev">
            <FolderPlus aria-hidden />
            Add a dev plugin
          </Button>
        }
      />
      <SectionCard id="installed" heading="Installed" description={`Plugins in ${dir}. A new one stays off until you enable it and allow what it asks for.`}>
        {!loaded ? (
          <p className="px-4 py-3 text-caption">Loading…</p>
        ) : names.length === 0 ? (
          <p className="px-4 py-3 text-caption" data-testid="plugins-none">
            No plugins yet. Add a dev plugin from a folder, or put one in {dir}.
          </p>
        ) : (
          names.map((n, i) => <PluginRow key={n} name={n} env={envs[n]} className={i > 0 ? "border-t border-border" : undefined} onLogs={setLogsOf} onUninstall={setUninstallOf} />)
        )}
      </SectionCard>
      <BrowseSection />
      {pageSections(schema, page).map((sf) => (
        <SettingsSection key={sf.section.id} schema={schema} pageId={page.id} section={sf} />
      ))}
      {uninstallOf && (
        <UninstallDialog
          name={uninstallOf}
          onClose={() => {
            setUninstallOf(null);
          }}
        />
      )}
      {logsOf && (
        <LogsDialog
          plugin={logsOf}
          displayName={logsTitle}
          onClose={() => {
            setLogsOf(null);
          }}
        />
      )}
    </>
  );
}
