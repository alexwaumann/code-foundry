import { ArrowUpCircle, Check, Download, Loader2, RotateCw, X } from "lucide-react";
import type { PluginEnvironmentView, PluginView } from "@/api/plugin";
import { CatalogRow, RowButton, RowSwitch, RowWorking } from "@/components/settings/catalog/CatalogRow";
import { Button } from "@/components/ui/button";
import { startCommandNamed } from "@/keys/bindings";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import { dismissInstallFailure, dismissPluginFailure, installPlugin, runPluginAction, updatePlugin, usePluginRegistryStore } from "@/stores/pluginRegistry";
import { usePlugin } from "@/stores/plugins";
import { useProjectsStore } from "@/stores/projects";
import { useUpdateRunStore } from "@/stores/updateRun";
import { PillView } from "../parts";
import { hasUpdate, pluginMain, pluginMenu, rowPill, type PluginMain } from "./model";
import { entryAction, entryPill, progressWords, shortSource } from "./registry";
import { SecretsList } from "./SecretsSection";
import { processLine, scopeWords } from "./state";

/**
 * What a plugin adds to new threads: env, PATH, add-dirs, who gets it. New shells get the
 * env and PATH too; a running thread says so in its header until restarted
 * (docs/notes/plugins-env-restart.md).
 */
function EnvSummary({ env }: { env: PluginEnvironmentView }) {
  const projects = useProjectsStore((s) => s.byId);
  const projectName = (id: string) => projects[id]?.name ?? id;
  const empty = env.env.length === 0 && env.pathPrepend.length === 0 && env.addDirs.length === 0;
  if (empty && env.issues.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-cf-border px-3 py-2" data-testid="plugin-env">
      <p className="text-caption-sm">New threads in {scopeWords(env.projects, env.noProject, projectName)} get:</p>
      <ul className="flex min-w-0 flex-col gap-0.5 font-mono text-caption-sm text-cf-text">
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
        <p key={i} className="text-caption-sm text-cf-warning-text">
          {i}
        </p>
      ))}
      <p className="text-caption-sm">New threads get this, and new shells all but the --add-dir folders. A running thread shows “Plugin environment changed” until you restart it.</p>
    </div>
  );
}

/** Which of a plugin's show commands are available for the selection (a string, so the selector is cheap and stable). */
function useAvailableSurfaces(name: string): ReadonlySet<string> {
  const available = useCommandsStore((s) =>
    s.commands
      .filter((c) => c.available && c.name.startsWith(`plugin.${name}.show.`))
      .map((c) => c.name)
      .join(","),
  );
  return new Set(available.split(","));
}

/** What an installed row shows before its switch (model.ts pluginMain). */
function MainCell({ name, main, busy }: { name: string; main: PluginMain; busy: boolean }) {
  switch (main?.kind) {
    case undefined:
      return null;
    case "working":
      return <RowWorking words={main.words} />;
    case "updated":
      return (
        <span className="flex shrink-0 items-center gap-1 text-caption-sm" data-testid="plugin-updated">
          <Check className="size-3" aria-hidden />
          Updated to {main.version}
        </span>
      );
    case "updating":
      return (
        <RowButton icon={ArrowUpCircle} busy onClick={() => undefined} testId="plugin-update">
          Updating…
        </RowButton>
      );
    case "update":
      return (
        <RowButton
          icon={main.retry ? RotateCw : ArrowUpCircle}
          disabled={busy}
          onClick={() => {
            void updatePlugin(name);
          }}
          testId="plugin-update"
        >
          {main.retry ? "Retry update" : `Update to ${main.version}`}
        </RowButton>
      );
  }
}

/** The last failed action on a row (the daemon's words), red under it, with a dismiss ×. */
function FailureLine({ name, message, action }: { name: string; message: string; action: string }) {
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-cf-error-text" role="alert" data-testid="plugin-failure" data-action={action}>
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="-my-1 shrink-0 text-cf-text-muted hover:text-cf-text"
        aria-label="Dismiss"
        onClick={() => {
          dismissPluginFailure(name);
        }}
        data-testid="plugin-failure-dismiss"
      >
        <X aria-hidden />
      </Button>
    </p>
  );
}

/** A row's details: the description, the process and source, problems, what it adds to new threads, its secrets when asked for. */
function PluginDetails({ p, env, secrets }: { p: PluginView; env: PluginEnvironmentView | undefined; secrets: boolean }) {
  const proc = processLine(p);
  const version = hasUpdate(p) ? `${p.version}, ${p.updateVersion} available` : p.version;
  return (
    <>
      {p.description && <p className="text-caption break-words">{p.description}</p>}
      <p className="text-caption-sm break-words tabular-nums">
        <span data-testid="plugin-version">{version}</span>
        {proc && (
          <>
            {" · "}
            <span data-testid="plugin-process">{proc}</span>
          </>
        )}
        {!p.dev && p.install && (
          <>
            {" · "}
            <span data-testid="plugin-installed-from">from {p.install.source.replace(/^https?:\/\/(github\.com\/)?/, "")}</span>
          </>
        )}
      </p>
      {p.dev && p.devPath && <p className="truncate font-mono text-caption-sm">{p.devPath}</p>}
      {p.disabledReason && <p className="text-caption-sm text-cf-warning-text">{p.disabledReason}</p>}
      {p.lastError && p.state !== "running" && (
        <p className="font-mono text-caption-sm break-words text-cf-error-text" data-testid="plugin-last-error">
          {p.lastError}
        </p>
      )}
      {p.issues.map((i) => (
        <p key={i} className="text-caption-sm text-cf-warning-text">
          {i}
        </p>
      ))}
      {env && p.enabled && <EnvSummary env={env} />}
      {secrets && <SecretsList name={p.name} />}
    </>
  );
}

/** One installed plugin (CatalogRow): its main action, switch and menu; everything else in its details. */
export function PluginRow({
  name,
  env,
  first,
  open,
  secrets,
  onToggle,
  onSecrets,
  onLogs,
  onUninstall,
}: {
  name: string;
  env: PluginEnvironmentView | undefined;
  first: boolean;
  open: boolean;
  secrets: boolean;
  onToggle: () => void;
  onSecrets: () => void;
  onLogs: () => void;
  onUninstall: () => void;
}) {
  const p = usePlugin(name);
  const busy = usePluginRegistryStore((s) => s.busy[name] ?? null);
  const failure = usePluginRegistryStore((s) => s.failures[name] ?? null);
  const updatedTo = useUpdateRunStore((s) => s.plugins.updated[name]);
  const available = useAvailableSurfaces(name);
  if (!p) return null;
  const flipping = busy === "enable" || busy === "disable";
  const pill = rowPill(p);
  return (
    <CatalogRow
      rowKey={p.name}
      name={p.displayName}
      description={p.description}
      first={first}
      open={open}
      onToggle={onToggle}
      attrs={{ "data-testid": "plugin-row-settings", "data-plugin": p.name, "data-state": p.state }}
      pills={
        p.dev && (
          <span className="shrink-0 rounded-sm border border-cf-border px-1 text-caption-sm" data-testid="plugin-dev-pill">
            dev
          </span>
        )
      }
      action={
        <>
          {pill && <PillView pill={pill} />}
          <MainCell name={p.name} main={pluginMain(p, busy, failure, updatedTo)} busy={busy !== null} />
        </>
      }
      toggle={
        <RowSwitch
          checked={busy === "enable" ? true : busy === "disable" ? false : p.enabled}
          busy={flipping}
          disabled={busy !== null}
          label={`${p.displayName} enabled`}
          onChange={(on) => {
            void runPluginAction(p.name, on ? "enable" : "disable");
          }}
          testId="plugin-switch"
        />
      }
      menu={{
        label: `More for ${p.displayName}`,
        testId: "plugin-row-menu",
        items: pluginMenu(p, {
          available,
          busy: busy !== null,
          onSurface: startCommandNamed,
          onRestart: () => {
            void runPluginAction(p.name, "restart");
          },
          onLogs,
          onSecrets,
          onReload: () => {
            void runPluginAction(p.name, "reload");
          },
          onUninstall,
        }),
      }}
      below={failure && <FailureLine name={p.name} message={failure.message} action={failure.action} />}
      details={<PluginDetails p={p} env={env} secrets={secrets} />}
    />
  );
}

/** An install in progress, or the last one's failure (the daemon's words, with a dismiss ×), under a row. */
function Progress({ name }: { name: string }) {
  const p = usePluginRegistryStore((s) => s.progress[name]);
  if (!p) return null;
  const failed = p.phase === "failed";
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-caption-sm", failed ? "break-words text-cf-error-text" : "text-cf-text-muted")} data-testid="registry-progress" data-phase={p.phase} role={failed ? "alert" : "status"}>
      {!failed && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
      <span className="min-w-0">{progressWords(p)}</span>
      {failed && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="-my-1 ml-auto shrink-0 self-start text-cf-text-muted hover:text-cf-text"
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

/** One registry entry (CatalogRow): Install, Update to X or how it is installed; what it asks for and where it comes from in its details. */
export function EntryRow({ name, first, open, onToggle }: { name: string; first: boolean; open: boolean; onToggle: () => void }) {
  const e = usePluginRegistryStore((s) => s.browse?.entries.find((x) => x.name === name));
  const busy = usePluginRegistryStore((s) => s.busy[name] ?? null);
  const inProgress = usePluginRegistryStore((s) => s.progress[name] !== undefined);
  const failure = usePluginRegistryStore((s) => s.failures[name] ?? null);
  if (!e) return null;
  const action = entryAction(e);
  const pill = entryPill(e);
  return (
    <CatalogRow
      rowKey={e.name}
      name={e.displayName}
      description={e.description}
      first={first}
      open={open}
      onToggle={onToggle}
      attrs={{ "data-testid": "registry-entry", "data-plugin": e.name, "data-relation": e.relation }}
      action={
        <>
          {e.relation === "installed" ? (
            <span className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-caption-sm" data-testid="registry-installed-mark">
              <Check className="size-3" aria-hidden />
              Installed
            </span>
          ) : (
            e.relation !== "update" && pill && <PillView pill={pill} className={cn(e.relation === "other-source" && "max-w-1/2 truncate")} />
          )}
          {action === "install" && (
            <RowButton
              icon={Download}
              busy={busy === "install"}
              disabled={!e.available || busy !== null}
              onClick={() => {
                void installPlugin(e.name);
              }}
              testId="registry-install"
            >
              Install
            </RowButton>
          )}
          {action === "update" && (
            <RowButton
              icon={failure?.action === "update" ? RotateCw : ArrowUpCircle}
              busy={busy === "update"}
              disabled={busy !== null}
              onClick={() => {
                void updatePlugin(e.name);
              }}
              testId="registry-update"
            >
              {busy === "update" ? "Updating…" : failure?.action === "update" ? "Retry update" : `Update to ${e.version}`}
            </RowButton>
          )}
        </>
      }
      below={
        inProgress ? <Progress name={e.name} /> : failure && <FailureLine name={e.name} message={failure.message} action={failure.action} />
      }
      details={
        <>
          {e.description && <p className="text-caption break-words">{e.description}</p>}
          <p className="text-caption-sm break-words" data-testid="registry-permissions">
            {e.permissionLines.length === 0 ? "Asks for no permissions." : `May ${e.permissionLines.join("; ")}.`}
          </p>
          <p className="truncate font-mono text-caption-sm">
            {e.version} · {e.repo ? `${e.repo} · ` : ""}from {shortSource(e.registry)}
          </p>
        </>
      }
    />
  );
}
