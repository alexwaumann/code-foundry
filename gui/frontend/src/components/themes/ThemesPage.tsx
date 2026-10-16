import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, Link2, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useEscapeCloses } from "@/components/window/useEscapeCloses";
import { useColorScheme, useThemeSlots, type ThemePreference } from "@/lib/theme";
import { themeById, type Theme } from "@/themes";
import { saveSettings, useSettingValue } from "@/stores/settings";
import {
  acceptPairHint,
  applyPreview,
  dismissPairHint,
  filterThemes,
  previewedId,
  previewTheme,
  resetPreview,
  schemeNote,
  setPickerQuery,
  setPickerSlot,
  useThemePickerStore,
  type ThemeSlot,
} from "@/stores/themePicker";
import { closeThemes } from "@/stores/views";
import { ThemeAa, ThemeStrip } from "./ThemeChip";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeScope } from "./ThemeScope";

const SLOT_LABEL: Record<ThemeSlot, string> = { dark: "Dark theme", light: "Light theme" };

function themeOf(id: string): Theme {
  const t = themeById.get(id);
  if (!t) throw new Error(`theme ${id} is not in the catalog`);
  return t;
}

/**
 * The Themes page (theme.pick; docs/notes/theme-engine-4-picker.md). A control bar (the
 * scheme and the two slots, one of which is being edited), the editing slot's themes on
 * the left, and on the right a gallery in the previewed theme. Selecting a theme previews
 * it in the gallery only; Apply writes the slot (theme.set-dark / theme.set-light) and the
 * window follows. Leaving the page drops the preview.
 */
export function ThemesPage() {
  const slot = useThemePickerStore((s) => s.slot);
  const preview = useThemePickerStore((s) => s.preview);
  const query = useThemePickerStore((s) => s.query);
  const slots = useThemeSlots();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEscapeCloses(closeThemes);

  const list = useMemo(() => filterThemes(slot, query), [slot, query]);
  const shownId = previewedId({ slot, preview }, slots);

  useEffect(() => {
    listRef.current?.focus();
  }, []);
  // Keep the previewed row in view as the arrows move it (jsdom has no scrollIntoView).
  useEffect(() => {
    const row = document.getElementById(`theme-option-${shownId}`);
    if (row && "scrollIntoView" in row) row.scrollIntoView({ block: "nearest" });
  }, [shownId]);

  const move = (delta: 1 | -1) => {
    if (list.length === 0) return;
    const i = list.findIndex((t) => t.id === shownId);
    const next = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next) previewTheme(next.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    const inSearch = t === searchRef.current;
    // Other fields and the buttons keep their own keys (Enter clicks a button).
    if (!inSearch && t.closest("input, textarea, button, [role=radio], [data-radix-popper-content-wrapper]")) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
        return;
      case "Enter":
        e.preventDefault();
        void applyPreview();
        return;
      case "/":
        if (inSearch) return;
        e.preventDefault();
        searchRef.current?.focus();
        return;
      case "Escape":
        // useEscapeCloses skips fields: in the search, the first Escape clears it.
        if (!inSearch) return;
        e.preventDefault();
        if (query) setPickerQuery("");
        else closeThemes();
        return;
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Themes" data-testid="themes-page" data-keys-local onKeyDown={onKeyDown}>
      <PaneHeader className="gap-3 px-4">
        <h1 className="text-sm font-semibold">Themes</h1>
        <Button variant="ghost" size="icon-xs" className="ml-auto [--wails-draggable:no-drag]" aria-label="Close themes" onClick={closeThemes}>
          <X />
        </Button>
      </PaneHeader>
      <ControlBar slot={slot} slots={slots} />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-pane-border">
          <div className="relative px-3 pt-3 pb-2">
            <Search className="pointer-events-none absolute top-1/2 left-5 mt-0.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search themes"
              placeholder={`Search ${String(filterThemes(slot, "").length)} ${slot} themes`}
              value={query}
              onChange={(e) => {
                setPickerQuery(e.target.value);
              }}
              className="h-8 pr-8 pl-7 text-[13px]"
            />
            {!query && (
              <Kbd size="sm" className="absolute top-1/2 right-5 mt-0.5 -translate-y-1/2">
                /
              </Kbd>
            )}
          </div>
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label={`${slot === "dark" ? "Dark" : "Light"} themes`}
            aria-activedescendant={list.some((t) => t.id === shownId) ? `theme-option-${shownId}` : undefined}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
            data-testid="themes-list"
          >
            {list.map((t) => (
              <ThemeRow key={t.id} theme={t} previewed={t.id === shownId} current={t.id === slots[slot]} />
            ))}
            {list.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No {slot} themes match “{query}”.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-pane-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd size="sm">↑</Kbd>
              <Kbd size="sm">↓</Kbd> preview
            </span>
            <span className="flex items-center gap-1">
              <Kbd size="sm">↵</Kbd> apply
            </span>
            <span className="flex items-center gap-1">
              <Kbd size="sm">esc</Kbd> close
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <PreviewBar slot={slot} shown={themeOf(shownId)} current={themeOf(slots[slot])} previewing={preview !== null} />
          <PairHintLine slots={slots} />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* inert: a picture of the app, so Tab and clicks stay in the page (and no
                popover opens into the window's theme through a portal). */}
            <ThemeScope theme={themeOf(shownId)} className="rounded-xl border border-pane-border">
              <div inert>
                <ThemeGallery />
              </div>
            </ThemeScope>
          </div>
        </div>
      </div>
    </section>
  );
}

function ThemeRow({ theme, previewed, current }: { theme: Theme; previewed: boolean; current: boolean }) {
  return (
    <div
      id={`theme-option-${theme.id}`}
      role="option"
      aria-selected={previewed}
      // The name alone (the Aa sample and the swatches are pictures); the slot's theme is aria-current.
      aria-label={theme.name}
      aria-current={current || undefined}
      data-theme-id={theme.id}
      data-current={current || undefined}
      className={cn(
        "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] select-none",
        previewed ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onClick={() => {
        previewTheme(theme.id);
      }}
      onDoubleClick={() => {
        void applyPreview();
      }}
    >
      <ThemeAa theme={theme} />
      <span className="min-w-0 flex-1 truncate" data-testid="theme-name">
        {theme.name}
      </span>
      <ThemeStrip theme={theme} />
      <span className="flex w-4 shrink-0 justify-center">
        {current && <Check className="size-3.5 text-foreground" aria-hidden />}
      </span>
    </div>
  );
}

function ControlBar({ slot, slots }: { slot: ThemeSlot; slots: { dark: string; light: string } }) {
  const pref = (useSettingValue("appearance.theme") ?? "system") as ThemePreference;
  const scheme = useColorScheme();
  const save = (v: string) => {
    void saveSettings({ "appearance.theme": v }).then((res) => {
      if (!res.ok) toast.error("Cannot set the scheme", { description: res.issues["appearance.theme"] ?? res.error });
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-pane-border px-4 py-2.5" data-testid="themes-controls">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Scheme</span>
        <RadioGroup variant="segmented" value={pref} onValueChange={save} aria-label="Scheme" data-testid="themes-scheme">
          <RadioGroupChoice value="system">
            <Monitor /> System
          </RadioGroupChoice>
          <RadioGroupChoice value="light">
            <Sun /> Light
          </RadioGroupChoice>
          <RadioGroupChoice value="dark">
            <Moon /> Dark
          </RadioGroupChoice>
        </RadioGroup>
      </div>
      <div className="flex items-center gap-2" role="group" aria-label="Slot to edit">
        {(["dark", "light"] as const).map((s) => (
          <SlotChip key={s} slot={s} theme={themeOf(slots[s])} editing={s === slot} inUse={s === scheme} />
        ))}
      </div>
      <p className="min-w-0 truncate text-xs text-muted-foreground" data-testid="themes-scheme-note">
        {schemeNote(pref, scheme, themeOf(slots[scheme]).name)}
      </p>
    </div>
  );
}

function SlotChip({ slot, theme, editing, inUse }: { slot: ThemeSlot; theme: Theme; editing: boolean; inUse: boolean }) {
  const Icon = slot === "dark" ? Moon : Sun;
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={editing}
      className={cn("h-8 gap-2 px-2.5 font-normal", editing && "border-primary ring-1 ring-primary/40 dark:border-primary")}
      onClick={() => {
        setPickerSlot(slot);
      }}
      data-testid={`themes-slot-${slot}`}
    >
      <Icon className="text-muted-foreground" />
      <span className="text-muted-foreground">{SLOT_LABEL[slot]}:</span>
      <ThemeAa theme={theme} className="h-4 w-6 text-[10px]" />
      <span className="font-medium">{theme.name}</span>
      {inUse && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          in use
        </Badge>
      )}
    </Button>
  );
}

function PreviewBar({ slot, shown, current, previewing }: { slot: ThemeSlot; shown: Theme; current: Theme; previewing: boolean }) {
  const applying = useThemePickerStore((s) => s.applying);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-pane-border px-4" data-testid="themes-preview-bar">
      <span className="truncate text-[13px]">
        <span className="text-muted-foreground">{previewing ? "Previewing " : "Current: "}</span>
        <span className="font-medium" data-testid="themes-previewed-name">
          {shown.name}
        </span>
      </span>
      {previewing && (
        <>
          <span className="truncate text-xs text-muted-foreground">· {SLOT_LABEL[slot].toLowerCase()} is {current.name}</span>
          <Button variant="link" size="xs" className="px-1" onClick={resetPreview} data-testid="themes-reset">
            Back to current
          </Button>
        </>
      )}
      <Button size="sm" className="ml-auto" disabled={!previewing || applying} onClick={() => void applyPreview()} data-testid="themes-apply">
        Apply to {slot}
        <Kbd variant="inherit" size="sm">
          ↵
        </Kbd>
      </Button>
    </div>
  );
}

/** After an Apply: the theme's companion for the other slot, one click away; never filled by itself. */
function PairHintLine({ slots }: { slots: { dark: string; light: string } }) {
  const hint = useThemePickerStore((s) => s.hint);
  if (!hint || slots[hint.slot] === hint.themeId) return null;
  const pair = themeOf(hint.themeId);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-pane-border px-4 py-2 text-xs" role="status" data-testid="themes-pair-hint">
      <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <ThemeAa theme={pair} className="h-4 w-6 text-[10px]" />
      <span className="min-w-0 truncate text-muted-foreground">
        <span className="text-foreground">{pair.name}</span> is this theme&rsquo;s {hint.slot} companion. Use it for {hint.slot}?
      </span>
      <Button variant="outline" size="xs" onClick={() => void acceptPairHint()} data-testid="themes-pair-accept">
        Use for {hint.slot}
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss suggestion" onClick={dismissPairHint}>
        <X />
      </Button>
    </div>
  );
}
