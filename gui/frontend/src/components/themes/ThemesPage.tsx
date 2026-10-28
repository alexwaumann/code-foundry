import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Check, ChevronRight, Link2, Monitor, Moon, Search, Sun, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Tip } from "@/components/ui/tooltip";
import { DialogTitle } from "@/components/ui/dialog";
import { SheetHeader } from "@/components/window/SheetHeader";
import { useColorScheme, useThemeSlots, type ThemePreference } from "@/lib/theme";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById, type Theme } from "@/themes";
import { saveSettings, useSettingValue } from "@/stores/settings";
import {
  acceptPairHint,
  applyPreview,
  customiseTheme,
  deleteTheme,
  dismissPairHint,
  editTheme,
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
import { afterLeavingEditor, editorDirty, leaveEditor, revertEdits, setSaveOpen, useEditorAnalysis, useThemeEditorStore } from "@/stores/themeEditor";
import { deleteThemeFile, useThemesStore, useUserThemes } from "@/stores/themes";
import { closeThemes, themesToSettings } from "@/stores/views";
import { useWidth } from "@/lib/useWidth";
import { AskTheModel } from "./AskTheModel";
import { editorLayout } from "./editor/model";
import { SaveThemeDialog } from "./editor/SaveThemeDialog";
import { ThemeInspector } from "./editor/ThemeInspector";
import { ThemeAa, ThemeStrip } from "./ThemeChip";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeScope } from "./ThemeScope";

const SLOT_LABEL: Record<ThemeSlot, string> = { dark: "Dark theme", light: "Light theme" };

const DEFAULT_OF: Record<ThemeSlot, string> = { dark: DEFAULT_DARK, light: DEFAULT_LIGHT };

/** The theme id names; a user theme that just went away reads as its scheme's default until the slot moves. */
function themeOf(id: string, scheme?: ThemeSlot): Theme {
  const t = themeById.get(id) ?? (scheme ? themeById.get(DEFAULT_OF[scheme]) : undefined);
  if (!t) throw new Error(`theme ${id} is not in the catalog`);
  return t;
}

/**
 * The Themes page (theme.pick; docs/notes/theme-engine-4-picker.md). A control bar (the
 * scheme and the two slots, one of which is being edited), the editing slot's themes on
 * the left, and on the right a gallery in the previewed theme. Selecting a theme previews
 * it in the gallery only; Apply writes the slot (theme.set-dark / theme.set-light) and the
 * window follows. Leaving the page drops the preview. The list has two sections: the
 * user's own themes (docs/notes/user-themes.md) above the curated ones; a row's hover
 * actions copy a theme into them (Customise) or delete one of them. Shown in the settings
 * sheet (SettingsSheet) in place of Settings; the sheet's Escape runs themesEscape.
 */
export function ThemesPage() {
  const slot = useThemePickerStore((s) => s.slot);
  const preview = useThemePickerStore((s) => s.preview);
  const query = useThemePickerStore((s) => s.query);
  const slots = useThemeSlots();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editingId = useThemeEditorStore((s) => s.id);
  const [bodyRef, bodyWidth] = useWidth(1200);
  const layout = editorLayout(bodyWidth);
  const listMode = editingId ? layout.list : "full";

  // Re-renders when the user's themes change; filterThemes reads them (a few dozen rows: no memo).
  useUserThemes();
  const issues = useThemesStore((s) => s.issues);
  const list = filterThemes(slot, query);
  const yours = list.filter((t) => t.user);
  const curated = list.filter((t) => !t.user);
  const shownIssues = filterIssues(issues, query);
  const total = filterThemes(slot, "").length;
  const shownId = previewedId({ slot, preview }, slots);

  useEffect(() => {
    listRef.current?.focus();
  }, []);
  // Leaving the editor (×, Escape, Discard) hands the keyboard back to the list.
  const wasEditing = useRef(editingId);
  useEffect(() => {
    if (wasEditing.current !== null && editingId === null) listRef.current?.focus();
    wasEditing.current = editingId;
  }, [editingId]);
  // Keep the previewed row in view as the arrows move it (jsdom has no scrollIntoView).
  useEffect(() => {
    const row = document.getElementById(`theme-option-${shownId}`);
    if (row && "scrollIntoView" in row) row.scrollIntoView({ block: "nearest" });
  }, [shownId]);

  const move = (delta: 1 | -1) => {
    // In the editor the arrows stay put: moving to another theme would leave it (a row's click still does, asking first).
    if (list.length === 0 || editingId) return;
    const i = list.findIndex((t) => t.id === shownId);
    const next = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next) pickRow(next.id);
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
        // In the editor, Save… applies (the draft is not the file yet).
        if (!editingId) void applyPreview();
        return;
      case "/":
        if (inSearch) return;
        e.preventDefault();
        searchRef.current?.focus();
        return;
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Themes" data-testid="themes-page" data-keys-local onKeyDown={onKeyDown}>
      <SheetHeader className="gap-3 px-4">
        {/* Themes lives under Settings: the crumb shows the way out without the ×. */}
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1" data-testid="themes-crumbs">
          <button type="button" className="rounded-sm text-heading text-cf-text-muted outline-none hover:text-cf-text focus-visible:ring-2 focus-visible:ring-cf-focus" onClick={themesToSettings} data-testid="themes-crumb-settings">
            Settings
          </button>
          <ChevronRight className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
          <span className="sr-only"> › </span>
          <DialogTitle aria-current="page">Themes</DialogTitle>
        </nav>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close themes" onClick={closeThemes}>
          <X />
        </Button>
      </SheetHeader>
      <ControlBar slot={slot} slots={slots} />
      <div ref={bodyRef} className="flex min-h-0 flex-1" data-testid="themes-body" data-list={listMode}>
        {listMode !== "hidden" && (
          <div className={cn("flex shrink-0 flex-col border-r border-cf-divider", listMode === "strip" ? "w-14" : editingId ? "w-[240px]" : "w-[300px]")} data-testid="themes-list-column">
            {listMode === "full" && (
              <div className="relative px-3 pt-3 pb-2">
                <Search className="pointer-events-none absolute top-1/2 left-5 mt-0.5 size-3.5 -translate-y-1/2 text-cf-text-muted" />
                <Input
                  ref={searchRef}
                  type="search"
                  aria-label="Search themes"
                  placeholder={`Search ${String(total)} ${slot} themes`}
                  value={query}
                  onChange={(e) => {
                    setPickerQuery(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    // Escape with text clears it; on an empty search the sheet's Escape runs themesEscape.
                    if (e.key === "Escape" && query) setPickerQuery("");
                  }}
                  className="h-8 pr-8 pl-7 text-body-sm"
                />
                {!query && (
                  <Kbd size="sm" className="absolute top-1/2 right-5 mt-0.5 -translate-y-1/2">
                    /
                  </Kbd>
                )}
              </div>
            )}
            <div
              ref={listRef}
              role="listbox"
              tabIndex={0}
              aria-label={`${slot === "dark" ? "Dark" : "Light"} themes`}
              aria-activedescendant={list.some((t) => t.id === shownId) ? `theme-option-${shownId}` : undefined}
              className={cn("min-h-0 flex-1 overflow-y-auto pb-2 outline-none", listMode === "strip" ? "px-1.5 pt-2" : "px-2")}
              data-testid="themes-list"
              data-sheet-focus
            >
              {listMode === "strip" ? (
                <>
                  {yours.map((t) => (
                    <ThemeRow key={t.id} theme={t} previewed={t.id === shownId} current={t.id === slots[slot]} strip />
                  ))}
                  {yours.length > 0 && curated.length > 0 && <div className="mx-1.5 my-1.5 border-t border-cf-divider" aria-hidden />}
                  {curated.map((t) => (
                    <ThemeRow key={t.id} theme={t} previewed={t.id === shownId} current={t.id === slots[slot]} strip />
                  ))}
                </>
              ) : (
                <>
                  {(yours.length > 0 || !query || shownIssues.length > 0) && (
                    <ListSection label="Yours" count={yours.length} testId="themes-yours">
                      {yours.map((t) => (
                        <ThemeRow key={t.id} theme={t} previewed={t.id === shownId} current={t.id === slots[slot]} />
                      ))}
                      {yours.length === 0 && !query && <p className="px-2 pb-1 text-caption-sm">Customise a theme to make one of your own.</p>}
                      <ThemeIssues issues={shownIssues} />
                    </ListSection>
                  )}
                  {curated.length > 0 && (
                    <ListSection label="Curated" count={curated.length} testId="themes-curated">
                      {curated.map((t) => (
                        <ThemeRow key={t.id} theme={t} previewed={t.id === shownId} current={t.id === slots[slot]} />
                      ))}
                    </ListSection>
                  )}
                  {list.length === 0 && shownIssues.length === 0 && <p className="px-2 py-3 text-caption">No {slot} themes match “{query}”.</p>}
                </>
              )}
            </div>
            {listMode === "full" && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-cf-divider px-3 py-2 text-caption-sm" data-testid="themes-keys">
                {editingId ? (
                  // In the editor the list's keys do nothing: a click on a row leaves for it (asking first).
                  <span className="flex items-center gap-1">
                    <Kbd size="sm">esc</Kbd> close the editor
                  </span>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {editingId && <ThemeInspector width={layout.inspector} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {editingId ? <EditBar /> : <PreviewBar slot={slot} shown={themeOf(shownId, slot)} current={themeOf(slots[slot], slot)} previewing={shownId !== slots[slot]} />}
          <PairHintLine slots={slots} />
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <GalleryScope shown={themeOf(shownId, slot)} />
          </div>
        </div>
      </div>
      <SaveThemeDialog />
    </section>
  );
}


/** The files that did not load whose name or message has every word of the search. */
function filterIssues<T extends { file: string; message: string }>(issues: readonly T[], query: string): readonly T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return issues;
  return issues.filter((is) => words.every((w) => `${is.file} ${is.message}`.toLowerCase().includes(w)));
}

/** A row picked (click, arrows): previews it; in the editor, on another theme, the editor closes first (asking when it has changes). */
function pickRow(id: string): void {
  const editing = useThemeEditorStore.getState().id;
  if (editing === null || editing === id) {
    previewTheme(id);
    return;
  }
  afterLeavingEditor(() => {
    previewTheme(id);
  });
}

/**
 * The gallery in the previewed theme, or in the editor's draft: every edit repaints it
 * (only this scope's inline slots change; the gallery itself does not re-render).
 */
function GalleryScope({ shown }: { shown: Theme }) {
  const analysis = useEditorAnalysis();
  // At least 640px wide (the gallery's three columns): beside the editor in a narrow window it
  // scrolls sideways rather than squeezing. inert: a picture of the app, so Tab and clicks stay in the page (and no popover opens
  // into the window's theme through a portal).
  const gallery = useMemo(
    () => (
      <div inert>
        <ThemeGallery />
      </div>
    ),
    [],
  );
  return (
    <ThemeScope theme={analysis?.theme ?? shown} className="min-w-[640px] rounded-xl border border-cf-divider">
      {gallery}
    </ThemeScope>
  );
}

/** The editor's bar over the gallery: "Editing <name> · from <from>", Revert, Save… and Done. */
function EditBar() {
  const draft = useThemeEditorStore((s) => s.draft);
  const dirty = useThemeEditorStore((s) => editorDirty(s));
  const saveOpen = useThemeEditorStore((s) => s.saveOpen);
  const saveRef = useRef<HTMLButtonElement>(null);
  // The modal has no trigger of its own: closing it (Cancel, Escape, a save) puts the keyboard back on Save….
  const wasOpen = useRef(saveOpen);
  useEffect(() => {
    if (wasOpen.current && !saveOpen) saveRef.current?.focus();
    wasOpen.current = saveOpen;
  }, [saveOpen]);
  if (!draft) return null;
  const from = draft.from ? (themeById.get(draft.from)?.name ?? draft.from) : "";
  // Wraps rather than squeezes: in a narrow window the buttons go under the name, which keeps at least 8rem.
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-cf-divider px-4 py-1.5" data-testid="themes-edit-bar">
      <span className="min-w-32 flex-1 truncate text-body-sm" data-testid="themes-edit-title">
        <span className="text-cf-text-muted">Editing </span>
        <span className="font-medium" data-testid="themes-editing-name">
          {draft.name}
        </span>
        {/* "unsaved" before "from": in a narrow window the end of the line is cut. */}
        {dirty && <span className="text-caption"> · unsaved</span>}
        {from && <span className="text-caption"> · from {from}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" disabled={!dirty} onClick={revertEdits} data-testid="themes-revert">
          Revert
        </Button>
        <Button
          ref={saveRef}
          size="sm"
          onClick={() => {
            setSaveOpen(true);
          }}
          data-testid="themes-save"
        >
          Save…
        </Button>
        <Tip label="Close the editor">
          <Button variant="ghost" size="icon-xs" aria-label="Close the editor" onClick={() => void leaveEditor()} data-testid="themes-edit-done">
            <X />
          </Button>
        </Tip>
      </span>
    </div>
  );
}

/** A section of the list: its heading ("Yours · 2") and its rows. */
function ListSection({ label, count, testId, children }: { label: string; count: number; testId: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} data-testid={testId}>
      <p className="px-2 pt-2.5 pb-1 text-overline" aria-hidden>
        {label} · {count}
      </p>
      {children}
    </div>
  );
}

/**
 * The files in the themes directory that did not load (those the search matches), under the
 * user's themes: each with its reason (cut to two lines; the tooltip has all of it, the fix
 * is often at its end) and Delete (theme.delete --file, which asks first;
 * docs/notes/theme-fuzz-daemon.md).
 */
function ThemeIssues({ issues }: { issues: readonly { file: string; message: string }[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 px-2 pb-1" data-testid="themes-issues">
      {issues.map((is) => (
        <li key={is.file} className="flex items-start gap-1" data-testid="themes-issue">
          <Tip label={`${is.file} did not load: ${is.message}`}>
            <span className="line-clamp-2 min-w-0 flex-1 text-caption-sm text-cf-warning">
              {is.file} did not load: {is.message}
            </span>
          </Tip>
          <Tip label="Delete the file">
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-cf-text-muted hover:text-cf-error"
              onClick={() => void deleteThemeFile(is.file)}
              aria-label={`Delete ${is.file}`}
              data-testid="themes-issue-delete"
            >
              <Trash2 />
            </Button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}

/** A user theme's second line: where it came from and whether a thread made it. */
function originLine(theme: Theme): string {
  const parts: string[] = [];
  if (theme.from) parts.push(`from ${themeById.get(theme.from)?.name ?? theme.from}`);
  if (theme.createdBy) parts.push("by a thread");
  return parts.join(" · ");
}

/**
 * A row's actions, muted, shown on hover and on keyboard focus (they stay focusable while
 * folded away): Edit on the user's themes (theme.edit), Customise on every theme (a copy,
 * then the editor on it), Delete on the user's.
 */
function RowActions({ theme }: { theme: Theme }) {
  const stop = (e: ReactMouseEvent) => {
    e.stopPropagation();
  };
  return (
    <span
      className="flex max-w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-opacity group-hover/row:max-w-40 group-hover/row:opacity-100 focus-within:max-w-40 focus-within:opacity-100"
      onClick={stop}
      onDoubleClick={stop}
      // One action per gesture: the second click of a double-click (a row may have moved under the pointer by then) does nothing.
      onClickCapture={(e) => {
        if (e.detail > 1) e.stopPropagation();
      }}
      data-testid="theme-row-actions"
    >
      {theme.user && (
        <Button variant="ghost" size="xs" className="text-cf-text-muted hover:text-cf-text" onClick={() => void editTheme(theme.id)} aria-label={`Edit ${theme.name}`}>
          Edit
        </Button>
      )}
      <Button variant="ghost" size="xs" className="text-cf-text-muted hover:text-cf-text" onClick={() => void customiseTheme(theme.id)} aria-label={`Customise ${theme.name}`}>
        Customise
      </Button>
      {theme.user && (
        <Tip label="Delete">
          <Button variant="ghost" size="icon-xs" className="text-cf-text-muted hover:text-cf-error" onClick={() => void deleteTheme(theme.id)} aria-label={`Delete ${theme.name}`}>
            <Trash2 />
          </Button>
        </Tip>
      )}
    </span>
  );
}

/**
 * A row of the list. `strip`: the editor's narrow list (a small window), the Aa chip alone
 * with the name in a tooltip; a click still leaves the editor for that theme.
 */
function ThemeRow({ theme, previewed, current, strip }: { theme: Theme; previewed: boolean; current: boolean; strip?: boolean }) {
  // The theme in the editor: its second line says so, with its pins (-1: not this row).
  const inEditor = useThemeEditorStore((s) => s.id !== null);
  const editingPins = useThemeEditorStore((s) => (s.id === theme.id ? Object.keys(s.draft?.overrides ?? {}).length : -1));
  const origin = editingPins >= 0 ? `editing · ${String(editingPins)} pinned` : theme.user ? originLine(theme) : "";
  if (strip)
    return (
      <Tip label={editingPins >= 0 ? `${theme.name} · editing` : theme.name} side="right">
        <div
          id={`theme-option-${theme.id}`}
          role="option"
          aria-selected={previewed}
          aria-label={theme.name}
          aria-current={current || undefined}
          data-theme-id={theme.id}
          data-user={theme.user || undefined}
          data-current={current || undefined}
          className={cn("flex h-8 cursor-default items-center justify-center rounded-md select-none", previewed ? "bg-cf-control-hover" : "hover:bg-cf-control-hover/50")}
          onClick={(e) => {
            if (e.detail < 2) pickRow(theme.id);
          }}
        >
          <ThemeAa theme={theme} />
        </div>
      </Tip>
    );
  return (
    <div
      id={`theme-option-${theme.id}`}
      role="option"
      aria-selected={previewed}
      // The name alone (the Aa sample and the swatches are pictures); the slot's theme is aria-current.
      aria-label={theme.name}
      aria-current={current || undefined}
      data-theme-id={theme.id}
      data-user={theme.user || undefined}
      data-current={current || undefined}
      className={cn(
        "group/row flex min-h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-body-sm select-none",
        origin && "py-1",
        previewed ? "bg-cf-control-hover text-cf-text" : "hover:bg-cf-control-hover/50",
      )}
      onClick={(e) => {
        // The second click of a double-click is not a pick: the first one picked this row, and a
        // Customise or the editor opening in between can move another row under the pointer.
        if (e.detail < 2) pickRow(theme.id);
      }}
      onDoubleClick={() => {
        if (editingPins < 0 && useThemeEditorStore.getState().id === null) void applyPreview();
      }}
    >
      <ThemeAa theme={theme} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" data-testid="theme-name">
          {theme.name}
        </span>
        {origin && (
          <span className="truncate text-caption-sm" data-testid="theme-origin">
            {origin}
          </span>
        )}
      </span>
      {/* In the editor the list is narrow: names over swatches; the edited row has no actions. */}
      {!inEditor && <ThemeStrip theme={theme} className="group-hover/row:hidden group-focus-within/row:hidden" />}
      {editingPins < 0 && <RowActions theme={theme} />}
      <span className="flex w-4 shrink-0 justify-center">
        {current && <Check className="size-3.5 text-cf-text" aria-hidden />}
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
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-cf-divider px-4 py-2.5" data-testid="themes-controls">
      <div className="flex items-center gap-2">
        <span className="text-caption">Scheme</span>
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
          <SlotChip key={s} slot={s} theme={themeOf(slots[s], s)} editing={s === slot} inUse={s === scheme} />
        ))}
      </div>
      <p className="min-w-0 truncate text-caption" data-testid="themes-scheme-note">
        {schemeNote(pref, scheme, themeOf(slots[scheme], scheme).name)}
      </p>
      <AskTheModel />
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
      className={cn("h-8 gap-2 px-2.5 font-normal", editing && "border-cf-accent ring-1 ring-cf-accent/40 dark:border-cf-accent")}
      onClick={() => {
        if (!editing) afterLeavingEditor(() => { setPickerSlot(slot); });
      }}
      data-testid={`themes-slot-${slot}`}
    >
      <Icon className="text-cf-text-muted" />
      <span className="text-cf-text-muted">{SLOT_LABEL[slot]}:</span>
      <ThemeAa theme={theme} className="h-4 w-6" />
      <span className="font-medium">{theme.name}</span>
      {inUse && (
        <Badge variant="secondary" className="px-1.5 py-0">
          in use
        </Badge>
      )}
    </Button>
  );
}

function PreviewBar({ slot, shown, current, previewing }: { slot: ThemeSlot; shown: Theme; current: Theme; previewing: boolean }) {
  const applying = useThemePickerStore((s) => s.applying);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-cf-divider px-4" data-testid="themes-preview-bar">
      <span className="truncate text-body-sm">
        <span className="text-cf-text-muted">{previewing ? "Previewing " : "Current: "}</span>
        <span className="font-medium" data-testid="themes-previewed-name">
          {shown.name}
        </span>
      </span>
      {previewing && (
        <>
          <span className="truncate text-caption">· {SLOT_LABEL[slot].toLowerCase()} is {current.name}</span>
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
  const pair = themeById.get(hint.themeId);
  if (!pair) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-cf-divider px-4 py-2 text-body-sm" role="status" data-testid="themes-pair-hint">
      <Link2 className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <ThemeAa theme={pair} className="h-4 w-6" />
      <span className="min-w-0 truncate text-cf-text-muted">
        <span className="text-cf-text">{pair.name}</span> is this theme&rsquo;s {hint.slot} companion. Use it for {hint.slot}?
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
