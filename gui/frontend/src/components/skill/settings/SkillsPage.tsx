import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { InstalledSkillView, SkillKindView, SkillTierView } from "@/api/skill";
import type { OverflowItem } from "@/components/projects/OverflowMenu";
import { CatalogCard, CatalogLine, CatalogNotice, GroupHeader } from "@/components/settings/catalog/CatalogList";
import { CatalogToolbar } from "@/components/settings/catalog/CatalogToolbar";
import { Chip } from "@/components/settings/catalog/Chip";
import { catalogEntries, searchPlaceholder, updateAllWords } from "@/components/settings/catalog/model";
import { queryWords } from "@/components/settings/model";
import { PageHead } from "@/components/settings/PageHead";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import {
  openSkillMarketplace,
  refreshSkillMarketplaces,
  searchSkills,
  updateSkill,
  useInstalledSkillsError,
  useSkillMarketplaceStore,
  useSkillRefreshing,
  useSkillSearchError,
  useSkillSearching,
} from "@/stores/skill";
import { forgetUpdated, runUpdates, useUpdateRunStore } from "@/stores/updateRun";
import { ConfirmSkillDialog } from "./ConfirmSkillDialog";
import {
  chipValue,
  GROUP_LABELS,
  groupedIds,
  kindLabel,
  marketKeys,
  marketplaceCount,
  refreshHint,
  registriesSummary,
  rowKeys,
  searchedIds,
  shownWords,
  tierLabel,
  toggleChip,
  updatableRows,
  type ConfirmAction,
} from "./model";
import { RegistriesDialog } from "./RegistriesDialog";
import { InstalledRow, MarketRow } from "./SkillRows";

/** How long typing waits before it searches the marketplace (the Installed group filters at once). */
export const SEARCH_DEBOUNCE_MS = 150;

const TIERS = ["enterprise", "community"] as const;
const KINDS = ["plugin", "skill"] as const;
type Tier = (typeof TIERS)[number];
type Kind = (typeof KINDS)[number];

/** One line of the card: a group's header, an installed row, a marketplace hit, or a line of words. */
type Item = { kind: "group"; id: string; count: number } | { kind: "row"; key: string } | { kind: "market" } | { kind: "hit"; key: string } | { kind: "line"; id: "none" | "market-none" | "loading" | "installed-none" };

function itemKey(it: Item): string {
  switch (it.kind) {
    case "group":
      return `#${it.id}`;
    case "row":
      return it.key;
    case "market":
      return "#market";
    case "hit":
      return `hit:${it.key}`;
    case "line":
      return `line:${it.id}`;
  }
}

/** The search box and the chips: typing waits SEARCH_DEBOUNCE_MS, a chip searches at once with the text typed so far (taking over a wait). */
function useSkillQueryState() {
  // The page opens on the store's last query (the search the marketplace's open reads).
  const [text, setText] = useState(() => useSkillMarketplaceStore.getState().query.text);
  const [tiers, setTiers] = useState<Tier[]>(() => {
    const t = useSkillMarketplaceStore.getState().query.tier;
    return t ? [t] : [];
  });
  const [kinds, setKinds] = useState<Kind[]>(() => {
    const k = useSkillMarketplaceStore.getState().query.kind;
    return k ? [k] : [];
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const run = (t: string, tier: SkillTierView, kind: SkillKindView | "") => {
    clearTimeout(timer.current);
    void searchSkills(t, tier, kind);
  };
  return {
    text,
    tiers,
    kinds,
    type: (t: string) => {
      setText(t);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void searchSkills(t, chipValue(tiers), chipValue(kinds));
      }, SEARCH_DEBOUNCE_MS);
    },
    pickTier: (t: Tier) => {
      const next = toggleChip(tiers, t);
      setTiers(next);
      run(text, chipValue(next), chipValue(kinds));
    },
    pickKind: (k: Kind) => {
      const next = toggleChip(kinds, k);
      setKinds(next);
      run(text, chipValue(tiers), chipValue(next));
    },
  };
}

/** "Update all N" or "Updating 2 of 3…" in the Needs you header: the row's own update, one row at a time. */
function UpdateAll() {
  const running = useUpdateRunStore((s) => s.skills.running);
  const at = useUpdateRunStore((s) => s.skills.at);
  const total = useUpdateRunStore((s) => s.skills.total);
  const available = useSkillMarketplaceStore((s) => updatableRows(s.installed?.installed ?? []).length);
  const words = updateAllWords({ running, at, total }, available);
  if (!words) return null;
  const start = () => {
    const rows = updatableRows(useSkillMarketplaceStore.getState().installed?.installed ?? []);
    void runUpdates(
      "skills",
      rows.map((r) => ({ key: r.key, version: r.update?.version ?? "", run: () => updateSkill(r, { quiet: true }) })),
    );
  };
  return (
    <Button variant="outline" size="xs" className="h-5 bg-transparent dark:bg-transparent" disabled={running} onClick={start} data-testid="skill-update-all">
      {running && <Loader2 className="animate-spin" aria-hidden />}
      {words}
    </Button>
  );
}

/** The failures at the top of the card, in words. */
function Notices({ searching }: { searching: boolean }) {
  const installedError = useInstalledSkillsError();
  const pluginsError = useSkillMarketplaceStore((s) => s.installed?.pluginsError ?? "");
  const searchError = useSkillSearchError();
  const refreshError = useSkillMarketplaceStore((s) => s.search?.refreshError ?? "");
  return (
    <>
      {installedError && (
        <CatalogNotice tone="error" testId="skill-installed-error">
          Cannot read what is installed: {installedError}
        </CatalogNotice>
      )}
      {pluginsError && (
        <CatalogNotice tone="warning" testId="skill-plugins-error">
          claude plugin list failed, so the plugins are the last list read: {pluginsError}
        </CatalogNotice>
      )}
      {searching && searchError && (
        <CatalogNotice tone="error" testId="skill-search-error">
          The search failed: {searchError}
        </CatalogNotice>
      )}
      {refreshError && (
        <CatalogNotice tone="warning" testId="skill-refresh-error">
          The refresh failed, so this is the last read: {refreshError}
        </CatalogNotice>
      )}
    </>
  );
}

/**
 * Settings → Skills (docs/notes/skills-page-redesign.md): Claude Code plugins and standalone
 * skills from the marketplaces Claude Code has, on the catalog layout Settings → Plugins
 * shares. By default what is installed, grouped (Needs you, Enabled, Disabled); typing
 * adds the marketplace's hits after the installed rows that match; Browse all is the
 * marketplace alone. The page holds the marketplace open (stores/skill.ts), so a new epoch
 * re-reads it.
 */
export function SkillsPage({ page, section }: { schema: SettingsSchemaView; page: SettingPageView; section?: string | null | undefined }) {
  const { text, tiers, kinds, type, pickTier, pickKind } = useSkillQueryState();
  // A settings search hit lands here (the page mounts with it): its section is a mode or the dialog, not a place on the page.
  const [browse, setBrowse] = useState(section === "browse");
  const [registriesOpen, setRegistriesOpen] = useState(section === "registries");
  const [confirm, setConfirm] = useState<{ action: ConfirmAction; row: InstalledSkillView } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => openSkillMarketplace(), []);
  useEffect(() => {
    forgetUpdated("skills");
  }, []);

  const words = useMemo(() => queryWords(text), [text]);
  const kind = chipValue(kinds);
  const searching = words.length > 0;
  const updated = useUpdateRunStore((s) => s.skills.updated);

  const installed = useSkillMarketplaceStore(
    useShallow((s) => {
      const rows = s.installed?.installed ?? [];
      if (browse) return [];
      if (!searching) return groupedIds(rows, kind, updated);
      return searchedIds(rows, words, kind, new Set(s.searchedText === text ? s.search?.entries.map((e) => e.key) : []));
    }),
  );
  // What the store answered still being the whole marketplace is no answer to the words typed.
  const waiting = useSkillMarketplaceStore((s) => s.search === null || (searching && s.searchedText.trim() === ""));
  const hits = useSkillMarketplaceStore(useShallow((s) => (waiting ? [] : marketKeys(s.search?.entries ?? [], browse ? new Set() : rowKeys(installed)))));
  const total = useSkillMarketplaceStore((s) => s.search?.total ?? 0);
  const shown = useSkillMarketplaceStore((s) => s.search?.entries.length ?? 0);
  const loaded = useSkillMarketplaceStore((s) => s.installed !== null);
  const installedFailed = useInstalledSkillsError() !== "";
  const hasRegistries = useSkillMarketplaceStore((s) => (s.registries?.registries.length ?? 1) > 0);
  const searchBusy = useSkillSearching();
  const refreshing = useSkillRefreshing();
  const count = useSkillMarketplaceStore((s) => marketplaceCount(s.registries?.registries));
  const registriesLine = useSkillMarketplaceStore((s) => registriesSummary(s.registries?.registries));
  const now = useNow(60_000);
  const readLine = useSkillMarketplaceStore((s) => refreshHint(s.registries?.registries, now));

  const showMarket = browse || searching;
  // Hits hidden as installed rows above are in the daemon's total, not in this group.
  const marketTotal = total - (shown - hits.length);
  const tierOn = tiers.length > 0;

  const items = useMemo<Item[]>(() => {
    const out: Item[] = catalogEntries(installed);
    if (!showMarket) {
      if (out.length === 0) out.push(loaded ? { kind: "line", id: "installed-none" } : { kind: "line", id: "loading" });
      return out;
    }
    // Nothing anywhere is one line, unless a chip the header holds is what narrowed it.
    if (!browse && out.length === 0 && hits.length === 0 && !waiting && !searchBusy && !tierOn) return [{ kind: "line", id: "none" }];
    out.push({ kind: "market" });
    for (const key of hits) out.push({ kind: "hit", key });
    if (hits.length === 0 && !waiting && !searchBusy) out.push({ kind: "line", id: "market-none" });
    return out;
  }, [installed, hits, showMarket, browse, waiting, searchBusy, tierOn, loaded]);

  const toggle = useCallback((key: string) => {
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const menu: OverflowItem[] = [
    { label: "Refresh marketplaces", hint: refreshing ? "Refreshing…" : readLine, disabled: refreshing, onSelect: () => void refreshSkillMarketplaces(), testId: "skill-refresh" },
    {
      label: "Registries",
      hint: registriesLine,
      onSelect: () => {
        setRegistriesOpen(true);
      },
      testId: "skill-registries-open",
    },
  ];

  const openRegistries = (
    <button
      type="button"
      className="text-link hover:underline"
      onClick={() => {
        setRegistriesOpen(true);
      }}
      data-testid="skill-registries-link"
    >
      see Registries
    </button>
  );

  const renderItem = (it: Item, i: number) => {
    const first = i === 0;
    switch (it.kind) {
      case "group":
        return (
          <GroupHeader id={it.id} label={GROUP_LABELS[it.id] ?? it.id} count={it.count} first={first}>
            {it.id === "needs" && <UpdateAll />}
          </GroupHeader>
        );
      case "market":
        return (
          <GroupHeader id="market" label="In your marketplace" count={waiting ? null : marketTotal} note={waiting ? "Searching…" : shownWords(marketTotal, hits.length)} busy={searchBusy} first={first}>
            {TIERS.map((t) => (
              <Chip
                key={t}
                size="sm"
                label={tierLabel(t)}
                on={tiers.includes(t)}
                onClick={() => {
                  pickTier(t);
                }}
                testId={`skill-chip-${t}`}
              />
            ))}
          </GroupHeader>
        );
      case "row":
        return (
          <InstalledRow
            itemKey={it.key}
            first={first}
            open={open.has(it.key)}
            onToggle={() => {
              toggle(it.key);
            }}
            onConfirm={(action, row) => {
              setConfirm({ action, row });
            }}
          />
        );
      case "hit":
        return (
          <MarketRow
            itemKey={it.key}
            first={first}
            open={open.has(`hit:${it.key}`)}
            onToggle={() => {
              toggle(`hit:${it.key}`);
            }}
          />
        );
      case "line":
        switch (it.id) {
          case "loading":
            return !installedFailed && <CatalogLine first={first} testId="skills-loading">Loading…</CatalogLine>;
          case "installed-none":
            return (
              <CatalogLine first={first} testId="skills-installed-none">
                Nothing installed yet. Search above or press Browse all to install a plugin or skill.
              </CatalogLine>
            );
          case "none":
            return (
              <CatalogLine first={first} testId="skill-results-none">
                Nothing installed or in your marketplace matches “{text.trim()}”.
              </CatalogLine>
            );
          case "market-none":
            return (
              <CatalogLine first={first} testId="skill-results-none">
                {searching ? <>Nothing in your marketplace matches “{text.trim()}”.</> : hasRegistries ? "Nothing to browse yet." : <>Nothing to browse yet: {openRegistries}.</>}
              </CatalogLine>
            );
        }
    }
  };

  return (
    <>
      <PageHead page={page} />
      <CatalogToolbar
        testId="skill"
        search={{
          value: text,
          placeholder: searchPlaceholder(browse, count, { place: "your marketplace", browse: "Search the marketplace" }),
          label: "Search plugins and skills",
          onChange: type,
        }}
        chips={
          <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Kind">
            {KINDS.map((k) => (
              <Chip
                key={k}
                label={`${kindLabel(k)}s`}
                on={kinds.includes(k)}
                onClick={() => {
                  pickKind(k);
                }}
                testId={`skill-chip-${k}`}
              />
            ))}
          </div>
        }
        browse={{
          on: browse,
          count,
          onToggle: () => {
            setBrowse((b) => !b);
          },
        }}
        menu={{ label: "Marketplace options", items: menu, busy: refreshing }}
      />
      <CatalogCard testId="skill-catalog" notices={<Notices searching={showMarket} />} items={items} itemKey={itemKey} render={renderItem} />
      {registriesOpen && (
        <RegistriesDialog
          onClose={() => {
            setRegistriesOpen(false);
          }}
        />
      )}
      {confirm && (
        <ConfirmSkillDialog
          action={confirm.action}
          row={confirm.row}
          onClose={() => {
            setConfirm(null);
          }}
        />
      )}
    </>
  );
}
