import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Check, Download, Loader2, RefreshCw, Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { SkillKindView, SkillTierView } from "@/api/skill";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { SectionCard } from "@/components/settings/SectionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  browseAction,
  installSkill,
  refreshSkillMarketplaces,
  searchSkills,
  updateSkill,
  useSkillBusy,
  useSkillMarketplaceStore,
  useSkillRefreshing,
  useSkillSearchError,
  useSkillSearching,
} from "@/stores/skill";
import { chipValue, installedWords, kindLabel, resultsWords, tierLabel, toggleChip } from "./model";
import { FailureLine, mainAction, Pill, PluginSkills, quietAction, VersionText } from "./parts";

/** How long typing waits before it searches. */
export const SEARCH_DEBOUNCE_MS = 150;

const TIERS = ["enterprise", "community"] as const;
const KINDS = ["plugin", "skill"] as const;
type Tier = (typeof TIERS)[number];
type Kind = (typeof KINDS)[number];

/** A filter chip: pressed or not. */
function Chip({ label, on, onClick, testId }: { label: string; on: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-md border border-cf-border px-2 text-body-sm outline-none hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus dark:hover:bg-cf-control-hover/50",
        on ? "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50" : "text-cf-text-muted",
      )}
      onClick={onClick}
      data-testid={testId}
      data-on={on || undefined}
    >
      {on && <Check className="size-3" aria-hidden />}
      {label}
    </button>
  );
}

/** One Browse hit: name, tier, kind, version, by, description, keywords, a plugin's skills; Install, Update to X or Installed. */
function EntryRow({ itemKey, open, onToggle, className }: { itemKey: string; open: boolean; onToggle: (key: string) => void; className?: string | undefined }) {
  const e = useSkillMarketplaceStore((s) => s.search?.entries.find((x) => x.key === itemKey));
  const busy = useSkillBusy(itemKey);
  if (!e) return null;
  const action = browseAction(e);
  return (
    <div className={cn("flex min-w-0 gap-3 px-4 py-3", className)} data-testid="skill-entry" data-key={e.key} data-name={e.name} data-kind={e.kind} data-tier={e.tier} data-state={e.state}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-label">{e.name}</span>
          <Pill pill={{ label: tierLabel(e.tier), tone: "muted" }} testId="skill-tier" />
          <Pill pill={{ label: kindLabel(e.kind), tone: "" }} outline testId="skill-kind" />
          <VersionText kind={e.kind} version={e.version} lastUpdatedMs={e.lastUpdatedMs} />
        </div>
        {e.by && (
          <p className="truncate text-caption-sm" data-testid="skill-by">
            by {e.by}
          </p>
        )}
        {e.description && <p className="line-clamp-2 text-caption">{e.description}</p>}
        {e.keywords.length > 0 && (
          <p className="truncate text-caption-sm text-cf-text-muted/80" data-testid="skill-keywords">
            {e.keywords.join(" · ")}
          </p>
        )}
        {e.kind === "plugin" && (
          <PluginSkills
            skills={e.skills}
            open={open}
            onToggle={() => {
              onToggle(e.key);
            }}
          />
        )}
        <FailureLine itemKey={e.key} />
      </div>
      <div className="flex shrink-0 items-start">
        {action === "install" && (
          <Button variant="outline" size="xs" className={mainAction} disabled={busy !== null} onClick={() => void installSkill(e)} data-testid="skill-install">
            {busy === "install" ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            Install
          </Button>
        )}
        {action === "update" && (
          <Button variant="outline" size="xs" className={mainAction} disabled={busy !== null} onClick={() => void updateSkill(e)} data-testid="skill-browse-update">
            {busy === "update" ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUpCircle aria-hidden />}
            Update to {e.updateVersion}
          </Button>
        )}
        {action === "installed" && (
          <span className="flex h-6 items-center gap-1 px-1.5 text-caption-sm" data-testid="skill-installed-mark">
            <Check className="size-3" aria-hidden />
            {installedWords(e)}
          </span>
        )}
      </div>
    </div>
  );
}

/** The search field (debounced) and the chips; they set the store's query. */
function SearchBar() {
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
  const refreshing = useSkillRefreshing();

  // Typing waits SEARCH_DEBOUNCE_MS; a chip searches at once (with the text typed so far,
  // taking over a wait in progress). The page's open runs the store's query itself.
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
  const type = (t: string) => {
    setText(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void searchSkills(t, chipValue(tiers), chipValue(kinds));
    }, SEARCH_DEBOUNCE_MS);
  };

  const pickTier = (t: Tier) => {
    const next = toggleChip(tiers, t);
    setTiers(next);
    run(text, chipValue(next), chipValue(kinds));
  };
  const pickKind = (k: Kind) => {
    const next = toggleChip(kinds, k);
    setKinds(next);
    run(text, chipValue(tiers), chipValue(next));
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-2.5">
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-cf-text-muted" aria-hidden />
        <Input
          type="search"
          aria-label="Search plugins and skills"
          placeholder="Search by name, description, keyword or author"
          value={text}
          onChange={(ev) => {
            type(ev.target.value);
          }}
          className="h-7 pl-7 text-body-sm"
          data-testid="skill-search"
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Tier">
        {TIERS.map((t) => (
          <Chip
            key={t}
            label={tierLabel(t)}
            on={tiers.includes(t)}
            onClick={() => {
              pickTier(t);
            }}
            testId={`skill-chip-${t}`}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Kind">
        {KINDS.map((k) => (
          <Chip
            key={k}
            label={kindLabel(k)}
            on={kinds.includes(k)}
            onClick={() => {
              pickKind(k);
            }}
            testId={`skill-chip-${k}`}
          />
        ))}
      </div>
      <Button variant="ghost" size="xs" className={cn("shrink-0", quietAction)} disabled={refreshing} onClick={() => void refreshSkillMarketplaces()} data-testid="skill-refresh">
        <RefreshCw className={cn(refreshing && "animate-spin")} aria-hidden />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  );
}

/** "N results", the search's and the last refresh's failures in words. */
function StatusLine() {
  const total = useSkillMarketplaceStore((s) => s.search?.total ?? null);
  const shown = useSkillMarketplaceStore((s) => s.search?.entries.length ?? 0);
  const refreshError = useSkillMarketplaceStore((s) => s.search?.refreshError ?? "");
  const searching = useSkillSearching();
  const error = useSkillSearchError();
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 border-t border-cf-border px-4 py-2 text-caption-sm" data-testid="skill-results" role="status">
        {searching && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
        <span className="min-w-0 truncate">{total === null ? "Searching…" : resultsWords(total, shown)}</span>
      </div>
      {error && (
        <p className="border-t border-cf-border px-4 py-2.5 text-caption break-words text-cf-error-text" role="alert" data-testid="skill-search-error">
          The search failed: {error}
        </p>
      )}
      {refreshError && (
        <p className="border-t border-cf-border px-4 py-2.5 text-caption break-words text-cf-warning-text" role="alert" data-testid="skill-refresh-error">
          The refresh failed, so this is the last read: {refreshError}
        </p>
      )}
    </>
  );
}

/**
 * Settings → Skills → Browse: a search over every marketplace's plugins and skills (the
 * daemon's, at most SKILL_SEARCH_LIMIT hits), filter chips, and Install, Update to X or
 * Installed per hit. Hundreds of hits are virtualised in the page's scroll box.
 */
export function BrowseSection() {
  const keys = useSkillMarketplaceStore(useShallow((s) => s.search?.entries.map((e) => e.key) ?? []));
  const answered = useSkillMarketplaceStore((s) => s.search !== null);
  const text = useSkillMarketplaceStore((s) => s.query.text.trim());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((key: string) => {
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  return (
    <SectionCard id="browse" heading="Browse" description="Plugins and skills in your marketplaces. A skill is copied to ~/.claude/skills; a plugin is installed by Claude Code.">
      <SearchBar />
      <StatusLine />
      {answered && keys.length === 0 && (
        <p className="border-t border-cf-border px-4 py-3 text-caption" data-testid="skill-results-none">
          {text ? `Nothing matches “${text}”.` : "Nothing to browse yet: see Registries below."}
        </p>
      )}
      <VirtualStack
        items={keys}
        itemKey={(k) => k}
        estimate={96}
        testId="skill-entries"
        render={(k) => <EntryRow itemKey={k} open={open.has(k)} onToggle={toggle} className="border-t border-cf-border" />}
      />
    </SectionCard>
  );
}
