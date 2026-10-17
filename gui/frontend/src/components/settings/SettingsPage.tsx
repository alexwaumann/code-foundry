import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, FileText, GitBranch, Keyboard, Palette, Search, Settings2, SlidersHorizontal, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useEscapeCloses } from "@/components/window/useEscapeCloses";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { loadSettingsSchema, useSettingsStore } from "@/stores/settings";
import { closeSettings, setSettingsPage, useViewsStore } from "@/stores/views";
import { KeybindingsPage } from "./KeybindingsPage";
import { pageSections, queryWords, searchSettings, type SearchResult } from "./model";
import { PageHead } from "./PageHead";
import { SearchResults } from "./SearchResults";
import { SettingsSection } from "./SectionCard";

/** The nav's icon per page id; a page without one gets a generic gear. */
const pageIcons: Readonly<Partial<Record<string, LucideIcon>>> = {
  general: SlidersHorizontal,
  appearance: Palette,
  notifications: Bell,
  source: GitBranch,
  keybindings: Keyboard,
  advanced: Wrench,
};

/** Pages drawn by a component of their own, by id; the rest are section cards of fields. */
const customPages: Readonly<Partial<Record<string, (p: { schema: SettingsSchemaView; page: SettingPageView }) => React.JSX.Element>>> = {
  keybindings: KeybindingsPage,
};

function Banners() {
  const loadError = useSettingsStore((s) => s.snapshot?.loadError ?? "");
  const issues = useSettingsStore((s) => s.snapshot?.issues);
  const unknown = useMemo(() => (issues ?? []).filter((i) => i.message === "unknown setting").map((i) => i.key), [issues]);
  const noService = useSettingsStore((s) => s.snapshot === null);
  return (
    <>
      {noService && (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-body-sm" data-testid="settings-unavailable">
          The daemon has not sent settings yet. If this persists it may be older than this window; restart it.
        </p>
      )}
      {loadError && (
        <div className="mb-4 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body-sm" data-testid="settings-load-error">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">The settings file does not parse; the previous values stay in effect and saving is paused.</p>
            <p className="mt-0.5 font-mono break-words text-muted-foreground">{loadError}</p>
          </div>
        </div>
      )}
      {unknown.length > 0 && (
        <p className="mb-4 rounded-md border border-border px-3 py-2 text-caption">
          Unknown keys in the file are ignored: <span className="font-mono">{unknown.join(", ")}</span>
        </p>
      )}
    </>
  );
}

/** The left nav: one item per page. While searching, each shows its match count and none is current. */
function SettingsNav({ pages, current, counts, onPick }: { pages: readonly SettingPageView[]; current: string | null; counts: SearchResult["counts"] | null; onPick: (id: string) => void }) {
  return (
    <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-pane-border p-2" aria-label="Settings pages">
      {pages.map((p) => {
        const Icon = pageIcons[p.id] ?? Settings2;
        const n = counts?.[p.id];
        const on = p.id === current;
        return (
          <button
            key={p.id}
            type="button"
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-body-sm outline-none hover:bg-accent focus-visible:bg-accent",
              on && "bg-accent font-medium",
              n === 0 && "text-muted-foreground opacity-60",
            )}
            onClick={() => {
              onPick(p.id);
            }}
            data-testid={`settings-nav-${p.id}`}
          >
            <Icon className={cn("size-3.5 shrink-0", on ? "text-foreground" : "text-muted-foreground")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{p.title}</span>
            {n !== undefined && (
              <span className="text-caption-sm tabular-nums" data-testid="settings-nav-count">
                {n}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** A page of section cards. */
function FieldsPage({ schema, page }: { schema: SettingsSchemaView; page: SettingPageView }) {
  return (
    <>
      <PageHead page={page} />
      {pageSections(schema, page).map((s) => (
        <SettingsSection key={s.section.id} schema={schema} pageId={page.id} section={s} />
      ))}
    </>
  );
}

/**
 * The settings page (view.settings, cmd+,): tabs from the daemon's schema. A left nav of
 * pages, the current page's section cards, and a search across every page that replaces
 * the page with a flat list of matches while it has text.
 */
export function SettingsPage() {
  const schema = useSettingsStore((s) => s.schema);
  const schemaError = useSettingsStore((s) => s.schemaError);
  const path = useSettingsStore((s) => s.snapshot?.path ?? "");
  const pageId = useViewsStore((s) => s.settingsPage);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Esc clears the search first; with nothing to clear it closes the page.
  const escape = useCallback(() => {
    if (query) setQuery("");
    else closeSettings();
  }, [query]);
  useEscapeCloses(escape);

  useEffect(() => {
    void loadSettingsSchema();
    searchRef.current?.focus();
  }, []);

  const words = useMemo(() => queryWords(query), [query]);
  const searching = words.length > 0;
  const result = useMemo(() => (schema && searching ? searchSettings(schema, words) : null), [schema, searching, words]);
  const page = schema?.pages.find((p) => p.id === pageId) ?? schema?.pages[0];

  // A new page (or the search's results) starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page?.id, searching]);

  const pick = (id: string) => {
    setQuery("");
    setSettingsPage(id);
  };
  const Page = page ? (customPages[page.id] ?? FieldsPage) : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Settings" data-testid="settings-page">
      <PaneHeader className="gap-3 px-4">
        <h1 className="text-heading">Settings</h1>
        <div className="relative max-w-xs flex-1 [--wails-draggable:no-drag]">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              // useEscapeCloses leaves a field's Escape alone: this one is the page's.
              if (e.key !== "Escape") return;
              e.preventDefault();
              escape();
            }}
            // The pane header's compact size, beside its xs buttons.
            className="h-7 pl-7 text-body-sm"
          />
        </div>
        <Tip label={path} side="bottom">
          <span className="ml-auto truncate text-caption-sm font-mono" data-testid="settings-path">
            {tildify(path)}
          </span>
        </Tip>
        <Button variant="outline" size="xs" className="[--wails-draggable:no-drag]" onClick={() => void runCommand("settings.reveal")} data-testid="reveal-settings">
          <FileText /> Reveal settings file
        </Button>
        <Button variant="ghost" size="icon-xs" className="[--wails-draggable:no-drag]" aria-label="Close settings" onClick={closeSettings}>
          <X />
        </Button>
      </PaneHeader>
      <div className="flex min-h-0 flex-1">
        <SettingsNav pages={schema?.pages ?? []} current={searching ? null : (page?.id ?? null)} counts={result?.counts ?? null} onPick={pick} />
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
          <div className="mx-auto max-w-3xl" data-testid="settings-body" data-page={searching ? undefined : page?.id}>
            <Banners />
            {schemaError && <p className="text-body text-destructive">Cannot load the settings schema: {schemaError}</p>}
            {!schema && !schemaError && <p className="text-body text-muted-foreground">Loading…</p>}
            {schema && result && <SearchResults query={query.trim()} words={words} result={result} back={page?.title ?? "the page"} />}
            {schema && !result && page && Page && <Page key={page.id} schema={schema} page={page} />}
          </div>
        </div>
      </div>
    </section>
  );
}
