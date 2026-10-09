import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search, TriangleAlert, X } from "lucide-react";
import type { SettingFieldView } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { tildify } from "@/lib/path";
import { runCommand } from "@/stores/commands";
import { useConfirmStore } from "@/stores/confirm";
import { loadSettingsSchema, useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { closeSettings, useViewsStore } from "@/stores/views";
import { SettingRow } from "./SettingRow";

function matches(f: SettingFieldView, q: string): boolean {
  if (!q) return true;
  const hay = `${f.title} ${f.description} ${f.key}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

/** Escape closes the page, unless a dialog is open or a field is being edited. */
function useEscapeCloses(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (useUiStore.getState().palette.open || useViewsStore.getState().helpOpen || useConfirmStore.getState().pending) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.matches("input, select, textarea") || t.closest("[data-key-recorder]"))) return;
      closeSettings();
    };
    // Capture phase: runs before Radix closes a dialog on the same Escape.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, []);
}

function Banners() {
  const loadError = useSettingsStore((s) => s.snapshot?.loadError ?? "");
  const issues = useSettingsStore((s) => s.snapshot?.issues);
  const unknown = useMemo(() => (issues ?? []).filter((i) => i.message === "unknown setting").map((i) => i.key), [issues]);
  const noService = useSettingsStore((s) => s.snapshot === null);
  return (
    <>
      {noService && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="settings-unavailable">
          The daemon has not sent settings yet. If this persists it may be older than this window; restart it.
        </p>
      )}
      {loadError && (
        <div className="mb-4 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs" data-testid="settings-load-error">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">The settings file does not parse; the previous values stay in effect and saving is paused.</p>
            <p className="mt-0.5 font-mono break-words text-muted-foreground">{loadError}</p>
          </div>
        </div>
      )}
      {unknown.length > 0 && (
        <p className="mb-4 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          Unknown keys in the file are ignored: <span className="font-mono">{unknown.join(", ")}</span>
        </p>
      )}
    </>
  );
}

/** The settings page (view.settings, cmd+,): a form generated from the daemon's schema. */
export function SettingsPage() {
  const schema = useSettingsStore((s) => s.schema);
  const schemaError = useSettingsStore((s) => s.schemaError);
  const path = useSettingsStore((s) => s.snapshot?.path ?? "");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEscapeCloses();

  useEffect(() => {
    void loadSettingsSchema();
    searchRef.current?.focus();
  }, []);

  const groups = useMemo(() => {
    if (!schema) return [];
    return schema.groups
      .map((g) => ({ group: g, fields: schema.fields.filter((f) => f.group === g.id && matches(f, query.trim())) }))
      .filter((g) => g.fields.length > 0);
  }, [schema, query]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Settings" data-testid="settings-page">
      <PaneHeader className="gap-3 px-4">
        <h1 className="text-sm font-semibold">Settings</h1>
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            className="h-7 w-full rounded-md border border-input bg-background pr-2 pl-7 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title={path} data-testid="settings-path">
          {tildify(path)}
        </span>
        <Button variant="outline" size="xs" onClick={() => void runCommand("settings.reveal")} data-testid="reveal-settings">
          <FileText /> Reveal settings file
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close settings" title="Close (Esc)" onClick={closeSettings}>
          <X />
        </Button>
      </PaneHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 space-y-0.5 border-r border-pane-border p-2 text-[13px]" aria-label="Setting groups">
          {groups.map(({ group, fields }) => (
            <button
              key={group.id}
              type="button"
              className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left hover:bg-accent"
              onClick={() => {
                scrollRef.current?.querySelector(`[data-group="${group.id}"]`)?.scrollIntoView({ block: "start" });
              }}
            >
              <span>{group.title}</span>
              {query && <span className="text-[11px] text-muted-foreground">{fields.length}</span>}
            </button>
          ))}
        </nav>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mx-auto max-w-3xl">
            <Banners />
            {schemaError && <p className="text-sm text-destructive">Cannot load the settings schema: {schemaError}</p>}
            {!schema && !schemaError && <p className="text-sm text-muted-foreground">Loading…</p>}
            {schema && groups.length === 0 && <p className="text-sm text-muted-foreground">No settings match “{query}”.</p>}
            {groups.map(({ group, fields }) => (
              <section key={group.id} data-group={group.id} className="mb-8 scroll-mt-4" aria-labelledby={`group-${group.id}`}>
                <h2 id={`group-${group.id}`} className="text-base font-semibold">
                  {group.title}
                </h2>
                {group.description && <p className="mt-0.5 mb-2 text-xs text-muted-foreground">{group.description}</p>}
                <div>
                  {fields.map((f) => (
                    <SettingRow key={f.key} field={f} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
