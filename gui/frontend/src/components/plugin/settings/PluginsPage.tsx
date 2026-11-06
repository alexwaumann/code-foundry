import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderPlus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { pluginEnvironments, type PluginEnvironmentView } from "@/api/plugin";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import type { OverflowItem } from "@/components/projects/OverflowMenu";
import { CatalogCard, CatalogLine, CatalogNotice, GroupHeader } from "@/components/settings/catalog/CatalogList";
import { CatalogToolbar } from "@/components/settings/catalog/CatalogToolbar";
import { catalogEntries, readHint, searchPlaceholder } from "@/components/settings/catalog/model";
import { UpdateAll } from "@/components/settings/catalog/UpdateAll";
import { queryWords } from "@/components/settings/model";
import { PageHead } from "@/components/settings/PageHead";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { loadBrowse, updatePlugin, usePluginRegistryStore } from "@/stores/pluginRegistry";
import { loadPluginDirs, usePluginNames, usePluginsStore } from "@/stores/plugins";
import { useUiStore } from "@/stores/ui";
import { forgetUpdated, useUpdateRunStore } from "@/stores/updateRun";
import { pluginsDirWords } from "./dirs";
import { LogsDialog } from "./LogsDialog";
import { entryNames, GROUP_LABELS, groupedIds, matchingEntries, registriesSummary, searchedIds, updatablePlugins } from "./model";
import { EntryRow, PluginRow } from "./PluginRows";
import { RegistriesDialog } from "./RegistriesDialog";
import { emptyBrowse } from "./registry";
import { UninstallDialog } from "./UninstallDialog";

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

/** One line of the card: a group's header, an installed row, a registry entry, or a line of words. */
type Item = { kind: "group"; id: string; count: number } | { kind: "row"; key: string } | { kind: "market"; count: number } | { kind: "entry"; name: string } | { kind: "line"; id: "loading" | "none" | "plugins-none" | "market-none" };

function itemKey(it: Item): string {
  switch (it.kind) {
    case "group":
      return `#${it.id}`;
    case "row":
      return it.key;
    case "market":
      return "#market";
    case "entry":
      return `entry:${it.name}`;
    case "line":
      return `line:${it.id}`;
  }
}

/** A set with one key flipped. */
function flipped(s: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(s);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** The Needs you header's Update all: the rows' own update, quiet (each row says how it went). */
function UpdateAllPlugins() {
  const available = usePluginsStore((s) => updatablePlugins(Object.values(s.byName)).length);
  return (
    <UpdateAll
      scope="plugins"
      available={available}
      testId="plugin-update-all"
      steps={() => updatablePlugins(Object.values(usePluginsStore.getState().byName)).map((p) => ({ key: p.name, version: p.updateVersion, run: () => updatePlugin(p.name, { quiet: true }) }))}
    />
  );
}

/**
 * Settings → Plugins (docs/notes/plugins-page-redesign.md), on the catalog layout Settings →
 * Skills shares. By default the installed plugins, grouped (Needs you, Running, Disabled);
 * typing adds the registries' entries after the installed rows that match (both filtered
 * here: the daemon has no plugin search); Browse all is the registries alone. Enable keeps
 * its consent dialog (plugin.enable's confirm). "Add a dev plugin" runs plugin.dev from the
 * palette (its folder picker). The registries and the page's settings (plugins.registries)
 * are in a dialog from the page's ⋯ menu.
 */
export function PluginsPage({ schema, page }: { schema: SettingsSchemaView; page: SettingPageView }) {
  const [text, setText] = useState("");
  const [browse, setBrowse] = useState(false);
  const [registries, setRegistries] = useState<{ focusField: boolean } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [secrets, setSecrets] = useState<ReadonlySet<string>>(new Set());
  const [logsOf, setLogsOf] = useState<string | null>(null);
  const [uninstallOf, setUninstallOf] = useState<string | null>(null);
  const envs = useEnvironments();
  const logsTitle = usePluginsStore((s) => (logsOf ? (s.byName[logsOf]?.displayName ?? logsOf) : ""));
  const dir = usePluginsStore((s) => pluginsDirWords(s.dirs));
  useEffect(() => {
    void loadPluginDirs();
    void loadBrowse();
    forgetUpdated("plugins");
  }, []);

  const words = useMemo(() => queryWords(text), [text]);
  const searching = words.length > 0;
  const names = usePluginNames();
  const loaded = usePluginsStore((s) => s.loaded);
  const updated = useUpdateRunStore((s) => s.plugins.updated);
  const browseRead = usePluginRegistryStore((s) => s.browse !== null);
  const loading = usePluginRegistryStore((s) => s.loading);
  const error = usePluginRegistryStore((s) => s.error);
  const empty = usePluginRegistryStore((s) => emptyBrowse(s.browse, s.error));
  const failedRegistries = usePluginRegistryStore((s) => s.browse?.registries.filter((r) => r.error).length ?? 0);
  const count = usePluginRegistryStore((s) => s.browse?.entries.length ?? null);
  const registriesLine = usePluginRegistryStore((s) => registriesSummary(s.browse?.registries));
  const now = useNow(60_000);
  const readLine = usePluginRegistryStore((s) => readHint(s.browse?.registries.map((r) => r.fetchedAtMs) ?? [], now));

  const hits = usePluginRegistryStore(useShallow((s) => (searching ? matchingEntries(s.browse?.entries ?? [], words) : [])));
  const installed = usePluginsStore(
    useShallow((s) => {
      if (browse) return [];
      const list = names.flatMap((n) => s.byName[n] ?? []);
      return searching ? searchedIds(list, hits, words) : groupedIds(list, updated);
    }),
  );
  const entries = usePluginRegistryStore(
    useShallow((s) => {
      if (!browse && !searching) return [];
      return entryNames(s.browse?.entries ?? [], words, browse ? new Set() : new Set(installed));
    }),
  );

  const showMarket = browse || searching;
  const items = useMemo<Item[]>(() => {
    const out: Item[] = catalogEntries(installed);
    if (!showMarket) {
      if (out.length === 0) out.push({ kind: "line", id: loaded ? "plugins-none" : "loading" });
      return out;
    }
    if (!browse && entries.length === 0 && browseRead) return out.length === 0 ? [{ kind: "line", id: "none" }] : out;
    out.push({ kind: "market", count: entries.length });
    for (const name of entries) out.push({ kind: "entry", name });
    if (entries.length === 0 && browseRead) out.push({ kind: "line", id: "market-none" });
    return out;
  }, [installed, entries, showMarket, browse, browseRead, loaded]);

  const toggle = useCallback((key: string) => {
    setOpen((o) => flipped(o, key));
  }, []);
  const openRegistries = (focusField: boolean) => {
    setRegistries({ focusField });
  };
  const link = (words: string) => (
    <button
      type="button"
      className="text-link hover:underline"
      onClick={() => {
        openRegistries(true);
      }}
      data-testid="registry-none-link"
    >
      {words}
    </button>
  );

  const menu: OverflowItem[] = [
    { label: "Refresh registries", hint: loading ? "Reading the registries…" : readLine, disabled: loading, onSelect: () => void loadBrowse(true), testId: "registry-refresh" },
    {
      label: "Registries",
      hint: registriesLine,
      onSelect: () => {
        openRegistries(false);
      },
      testId: "registry-open",
    },
  ];

  const renderItem = (it: Item, i: number) => {
    const first = i === 0;
    switch (it.kind) {
      case "group":
        return (
          <GroupHeader id={it.id} label={GROUP_LABELS[it.id] ?? it.id} count={it.count} first={first}>
            {it.id === "needs" && <UpdateAllPlugins />}
          </GroupHeader>
        );
      case "market":
        return <GroupHeader id="market" label="In your registries" count={browseRead ? it.count : null} note={loading && !browseRead ? "Reading the registries…" : ""} busy={loading} first={first} />;
      case "row":
        return (
          <PluginRow
            name={it.key}
            env={envs[it.key]}
            first={first}
            open={open.has(it.key)}
            secrets={secrets.has(it.key)}
            onToggle={() => {
              toggle(it.key);
            }}
            onSecrets={() => {
              const showing = secrets.has(it.key);
              setSecrets((s) => flipped(s, it.key));
              if (!showing) setOpen((o) => new Set(o).add(it.key));
            }}
            onLogs={() => {
              setLogsOf(it.key);
            }}
            onUninstall={() => {
              setUninstallOf(it.key);
            }}
          />
        );
      case "entry":
        return (
          <EntryRow
            name={it.name}
            first={first}
            open={open.has(`entry:${it.name}`)}
            onToggle={() => {
              toggle(`entry:${it.name}`);
            }}
          />
        );
      case "line":
        switch (it.id) {
          case "loading":
            return (
              <CatalogLine first={first} testId="plugins-loading">
                Loading…
              </CatalogLine>
            );
          case "plugins-none":
            return (
              <CatalogLine first={first} testId="plugins-none">
                No plugins yet. Add a dev plugin from a folder, or put one in {dir}. A new one stays off until you enable it and allow what it asks for.
              </CatalogLine>
            );
          case "none":
            return (
              <CatalogLine first={first} testId="plugin-results-none">
                Nothing installed or in your registries matches “{text.trim()}”.
              </CatalogLine>
            );
          case "market-none":
            return searching ? (
              <CatalogLine first={first} testId="plugin-results-none">
                Nothing in your registries matches “{text.trim()}”.
              </CatalogLine>
            ) : empty === "no-registry" ? (
              <CatalogLine first={first} testId="registry-none">
                No registry configured. {link("Add one in Registries")}
              </CatalogLine>
            ) : (
              empty === "none-listed" && (
                <CatalogLine first={first} testId="registry-empty">
                  No plugins listed yet.
                </CatalogLine>
              )
            );
        }
    }
  };

  return (
    <>
      <PageHead
        page={page}
        aside={
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              useUiStore.getState().openPalette("", "plugin.dev");
            }}
            data-testid="plugin-dev"
          >
            <FolderPlus aria-hidden />
            Add a dev plugin
          </Button>
        }
      />
      <CatalogToolbar
        testId="plugin"
        search={{ value: text, placeholder: searchPlaceholder(browse, count, { place: "your registries", browse: "Search the registries" }), label: "Search plugins", onChange: setText }}
        browse={{
          on: browse,
          count,
          onToggle: () => {
            setBrowse((b) => !b);
          },
        }}
        menu={{ label: "Registry options", items: menu, busy: loading }}
      />
      <CatalogCard
        testId="plugin-catalog"
        notices={
          <>
            {error && (
              <CatalogNotice tone="error" testId="registry-error">
                {error}
              </CatalogNotice>
            )}
            {failedRegistries > 0 && (
              <CatalogNotice tone="warning" testId="registry-failed">
                {failedRegistries === 1 ? "A registry" : `${String(failedRegistries)} registries`} could not be read, so this is the last read. Registries in the page&apos;s ⋯ menu says why.
              </CatalogNotice>
            )}
          </>
        }
        items={items}
        itemKey={itemKey}
        render={renderItem}
      />
      {registries && (
        <RegistriesDialog
          schema={schema}
          page={page}
          focusField={registries.focusField}
          onClose={() => {
            setRegistries(null);
          }}
        />
      )}
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
