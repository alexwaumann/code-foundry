import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Bell, GitBranch, Keyboard, Palette, Search, Settings2, SlidersHorizontal, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import { FinderMark } from "@/components/icons/FinderMark";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { FlameNavIcon } from "@/components/ember/Flame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { DialogTitle } from "@/components/ui/dialog";
import { SheetHeader } from "@/components/window/SheetHeader";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { loadSettingsSchema, useSettingsStore } from "@/stores/settings";
import { closeSettings, setSettingsPage, useViewsStore } from "@/stores/views";
import { guiPages } from "./guiPages";
import { KeybindingsPage } from "./KeybindingsPage";
import { pageSections, queryWords, searchGuiPages, searchSectionRows, searchSettings, type SearchResult } from "./model";
import { PageHead } from "./PageHead";
import { SearchResults } from "./SearchResults";
import { SettingsSection } from "./SectionCard";
import { sectionRowSearch } from "./sectionLinks";

/** The nav's icon per page id; a page without one gets a generic gear. Ember's is its flame. */
const pageIcons: Readonly<Partial<Record<string, LucideIcon | ComponentType<{ className?: string }>>>> = {
  general: SlidersHorizontal,
  appearance: Palette,
  notifications: Bell,
  source: GitBranch,
  keybindings: Keyboard,
  advanced: Wrench,
  ember: FlameNavIcon,
  ...Object.fromEntries(guiPages.map((g) => [g.page.id, g.icon])),
};

/** Pages drawn by a component of their own, by id; the rest are section cards of fields. */
const customPages: Readonly<Partial<Record<string, (p: { schema: SettingsSchemaView; page: SettingPageView }) => React.JSX.Element>>> = {
  keybindings: KeybindingsPage,
  ...Object.fromEntries(guiPages.map((g) => [g.page.id, g.component])),
};

function Banners() {
  const loadError = useSettingsStore((s) => s.snapshot?.loadError ?? "");
  const issues = useSettingsStore((s) => s.snapshot?.issues);
  const unknown = useMemo(() => (issues ?? []).filter((i) => i.message === "unknown setting").map((i) => i.key), [issues]);
  const noService = useSettingsStore((s) => s.snapshot === null);
  return (
    <>
      {noService && (
        <p className="mb-4 rounded-md border border-cf-warning/40 bg-cf-warning-surface px-3 py-2 text-body-sm" data-testid="settings-unavailable">
          The daemon has not sent settings yet. If this persists it may be older than this window; restart it.
        </p>
      )}
      {loadError && (
        <div className="mb-4 flex gap-2 rounded-md border border-cf-error/40 bg-cf-error-surface px-3 py-2 text-body-sm" data-testid="settings-load-error">
          <TriangleAlert className="size-4 shrink-0 text-cf-error-text" />
          <div>
            <p className="font-medium">The settings file does not parse; the last settings that loaded stay in effect (the defaults if none have) and saving is paused until you fix it.</p>
            <p className="mt-0.5 font-mono break-words text-cf-text-muted">{loadError}</p>
          </div>
        </div>
      )}
      {unknown.length > 0 && (
        <p className="mb-4 rounded-md border border-cf-border px-3 py-2 text-caption">
          Unknown keys in the file are ignored: <span className="font-mono">{unknown.join(", ")}</span>
        </p>
      )}
    </>
  );
}

/** The left nav: one item per page. While searching, each shows its match count and none is current. */
function SettingsNav({ pages, current, counts, onPick }: { pages: readonly SettingPageView[]; current: string | null; counts: SearchResult["counts"] | null; onPick: (id: string) => void }) {
  return (
    <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-cf-divider p-2" aria-label="Settings pages">
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
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-body-sm outline-none hover:bg-cf-control-hover focus-visible:bg-cf-control-hover",
              on && "bg-cf-control-hover font-medium",
              n === 0 && "text-cf-text-muted opacity-60",
            )}
            onClick={() => {
              onPick(p.id);
            }}
            data-testid={`settings-nav-${p.id}`}
          >
            <Icon className={cn("size-3.5 shrink-0", on ? "text-cf-text" : "text-cf-text-muted")} aria-hidden />
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
 * the page with a flat list of matches while it has text. Shown in the settings sheet
 * (SettingsSheet), which also handles its Escape.
 */
export function SettingsPage() {
  const schema = useSettingsStore((s) => s.schema);
  const schemaError = useSettingsStore((s) => s.schemaError);
  const path = useSettingsStore((s) => s.snapshot?.path ?? "");
  const pageId = useViewsStore((s) => s.settingsPage);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The search takes the keyboard on open (the sheet leaves its first focus to the page).
  useEffect(() => {
    void loadSettingsSchema();
    searchRef.current?.focus();
  }, []);

  const words = useMemo(() => queryWords(query), [query]);
  const searching = words.length > 0;
  const result = useMemo(() => (schema && searching ? searchSettings(schema, words) : null), [schema, searching, words]);
  // A GUI page may also be a schema page (Plugins: its settings section): the schema's wins, drawn by the GUI's component.
  const pages = useMemo(() => (schema ? [...schema.pages, ...guiPages.map((g) => g.page).filter((g) => !schema.pages.some((p) => p.id === g.id))] : []), [schema]);
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  // The GUI's own pages have no fields: their sections are found by name (Skills › Browse).
  // And so are the rows the GUI adds to schema sections (Dictation's Model), unless a field there matched.
  const guiHits = useMemo(() => {
    if (!schema || !searching || !result) return null;
    const pagesHit = searchGuiPages(
      guiPages.map((g) => g.page),
      new Set(schema.pages.map((p) => p.id)),
      words,
    );
    const rowsHit = searchSectionRows(schema, sectionRowSearch, result.hits, words);
    return { hits: [...rowsHit.hits, ...pagesHit.hits], counts: pagesHit.counts, rowCounts: rowsHit.counts };
  }, [schema, searching, words, result]);
  const counts = useMemo(() => {
    if (!result) return null;
    const out: Record<string, number> = { ...result.counts, ...guiHits?.counts };
    for (const [id, n] of Object.entries(guiHits?.rowCounts ?? {})) out[id] = (out[id] ?? 0) + n;
    return out;
  }, [result, guiHits]);
  // A section hit opens its page there (after the page change scrolls to the top).
  const [toSection, setToSection] = useState<string | null>(null);

  // A new page (or the search's results) starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page?.id, searching]);

  useEffect(() => {
    const box = scrollRef.current;
    const body = box?.firstElementChild;
    if (!toSection || searching || !box || !body) return;
    const go = () => {
      box.querySelector(`[data-section="${CSS.escape(toSection)}"]`)?.scrollIntoView({ block: "start" });
    };
    const frame = requestAnimationFrame(go);
    // A page that reads its content once shown (Skills) grows above the section: follow it
    // until it settles or the user scrolls.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(go);
    ro?.observe(body);
    const stop = () => {
      setToSection(null);
    };
    const timer = setTimeout(stop, 1500);
    box.addEventListener("wheel", stop, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      clearTimeout(timer);
      box.removeEventListener("wheel", stop);
    };
  }, [toSection, searching, page?.id]);

  const pick = (id: string) => {
    setQuery("");
    setSettingsPage(id);
  };
  const openSection = (pageId: string, sectionId: string) => {
    pick(pageId);
    setToSection(sectionId);
  };
  const Page = page ? (customPages[page.id] ?? FieldsPage) : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Settings" data-testid="settings-page">
      <SheetHeader className="gap-3 px-4">
        <DialogTitle>Settings</DialogTitle>
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-cf-text-muted" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search settings"
            data-sheet-focus
            placeholder="Search settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              // Escape with text clears it; on an empty search the sheet closes (SettingsSheet).
              if (e.key === "Escape" && query) setQuery("");
            }}
            // The header's compact size, beside its xs buttons.
            className="h-7 pl-7 text-body-sm"
          />
        </div>
        <Tip label={path} side="bottom">
          <span className="ml-auto truncate text-caption-sm font-mono" data-testid="settings-path">
            {tildify(path)}
          </span>
        </Tip>
        <Button variant="outline" size="xs" onClick={() => void runCommand("settings.reveal")} data-testid="reveal-settings">
          <FinderMark /> Open settings file in Finder
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close settings" onClick={closeSettings}>
          <X />
        </Button>
      </SheetHeader>
      <div className="flex min-h-0 flex-1">
        <SettingsNav pages={pages} current={searching ? null : (page?.id ?? null)} counts={counts} onPick={pick} />
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
          <div className="mx-auto max-w-3xl" data-testid="settings-body" data-page={searching ? undefined : page?.id}>
            <Banners />
            {schemaError && <p className="text-body text-cf-error-text">Cannot load the settings schema: {schemaError}</p>}
            {!schema && !schemaError && <p className="text-body text-cf-text-muted">Loading…</p>}
            {schema && result && <SearchResults query={query.trim()} words={words} result={result} sections={guiHits?.hits} onOpenSection={openSection} back={page?.title ?? "the page"} />}
            {schema && !result && page && Page && <Page key={page.id} schema={schema} page={page} />}
          </div>
        </div>
      </div>
    </section>
  );
}
