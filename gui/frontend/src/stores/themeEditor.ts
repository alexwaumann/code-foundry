/**
 * The Themes page's editor (theme.edit, docs/notes/theme-editor.md): one of the user's
 * themes as a draft, its base colours and pins (overrides), and what the inspector shows.
 * Page state only, like the picker's preview: the gallery paints the draft, the window
 * keeps its theme until Save writes the file (theme.save, with `apply` for "Use as my …
 * theme now"). Leaving with unsaved changes asks first (leaveEditor).
 *
 * Pins and staleness: a pin is an absolute value. When a pin is made (or the editor opens
 * a file) the slot's derived value is recorded as its basis; a pin whose slot derives
 * something else now is stale (staleOverrides in src/themes/contrast.ts).
 */
import { toast } from "sonner";
import { create } from "zustand";
import { invokeCommand } from "@/api/command";
import { themeSlots } from "@/lib/theme";
import { lightness } from "@/themes/color";
import { contrastReport, derivedValue, fixContrast, pinBasis, staleOverrides, withoutPin, type ContrastEntry, type StalePin } from "@/themes/contrast";
import { parseThemeFile, SCHEME_LIGHTNESS, schemeProblem, SLOT_GROUPS, themeFileJson, type SlotGroup, type ThemeBase, type ThemeScheme } from "@/themes/slots";
import { subscribeUserThemes, themeById, themeOf, type Theme, type UserThemeFile } from "@/themes";
import { runCommandForResult } from "./commands";
import { requestConfirm } from "./confirm";
import { getUiContext } from "./context";

/** A base colour: the nine, the optional link, and the terminal's (`terminal.ansi.<n>` for ANSI n). */
export type BaseKey =
  | "canvas"
  | "surface"
  | "text"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "highlight"
  | "link"
  | "terminal.foreground"
  | "terminal.cursor"
  | "terminal.cursorText"
  | "terminal.selection"
  | `terminal.ansi.${number}`;

/** The base colours a theme may leave out: each falls back to another (BASE_FALLBACK). */
export const OPTIONAL_BASE: ReadonlySet<BaseKey> = new Set<BaseKey>(["link", "terminal.cursor", "terminal.cursorText", "terminal.selection"]);

/** What an optional base colour uses when it is absent, in words. */
export const BASE_FALLBACK: Readonly<Partial<Record<BaseKey, string>>> = {
  link: "uses Info",
  "terminal.cursor": "uses the foreground",
  "terminal.cursorText": "uses the surface or the foreground",
  "terminal.selection": "the foreground at 20% over the surface",
};

/** A base colour's value, or undefined for an optional one the theme leaves out. */
export function baseValue(base: ThemeBase, key: BaseKey): string | undefined {
  if (key.startsWith("terminal.ansi.")) return base.terminal.ansi[Number(key.slice("terminal.ansi.".length))];
  switch (key) {
    case "terminal.foreground":
      return base.terminal.foreground;
    case "terminal.cursor":
      return base.terminal.cursor;
    case "terminal.cursorText":
      return base.terminal.cursorText;
    case "terminal.selection":
      return base.terminal.selection;
    default:
      return base[key as Exclude<BaseKey, `terminal.${string}`>];
  }
}

/** The base with one colour set (undefined clears an optional one). */
export function withBase(base: ThemeBase, key: BaseKey, value: string | undefined): ThemeBase {
  if (key.startsWith("terminal.")) {
    const sub = key.slice("terminal.".length);
    const terminal = { ...base.terminal, ansi: [...base.terminal.ansi] };
    if (sub.startsWith("ansi.")) {
      if (value !== undefined) terminal.ansi[Number(sub.slice(5))] = value;
      return { ...base, terminal };
    }
    const k = sub as "foreground" | "cursor" | "cursorText" | "selection";
    if (value === undefined) {
      if (k === "foreground") return base;
      const { [k]: _gone, ...rest } = terminal;
      return { ...base, terminal: rest };
    }
    return { ...base, terminal: { ...terminal, [k]: value } };
  }
  const k = key as Exclude<BaseKey, `terminal.${string}`>;
  if (value === undefined) {
    if (k !== "link") return base;
    const { link: _gone, ...rest } = base;
    return rest;
  }
  return { ...base, [k]: value };
}

export type EditorView = { readonly kind: "list" } | { readonly kind: "slot"; readonly name: string } | { readonly kind: "base"; readonly key: BaseKey };

interface ThemeEditorState {
  /** The theme being edited, null when the page is not in edit mode. */
  id: string | null;
  /** The file as last saved (or opened): what Revert goes back to. */
  saved: UserThemeFile | null;
  draft: UserThemeFile | null;
  /** Each pin's derived value when it was made (staleOverrides). */
  basis: Readonly<Record<string, string>>;
  view: EditorView;
  filter: string;
  pinnedOnly: boolean;
  /** Expanded slot groups, and "terminal-base" for the Base section's terminal row. */
  open: Readonly<Record<string, boolean>>;
  saveOpen: boolean;
  saving: boolean;
  /**
   * A newer file of this theme (a thread's save, the CLI, another window) that arrived
   * while the draft had unsaved edits: the inspector's "Changed on disk" line, until
   * Reload or Keep mine. A clean editor reloads by itself (syncFromDisk).
   */
  disk: UserThemeFile | null;
  /** The copy Customise just made, never saved: leaving the editor deletes it (discardCopy). */
  fresh: boolean;
}

const OPEN_GROUPS = (): Record<string, boolean> => Object.fromEntries(SLOT_GROUPS.map((g) => [g, g !== "terminal" && g !== "syntax"]));

const closed = (): ThemeEditorState => ({ id: null, saved: null, draft: null, basis: {}, view: { kind: "list" }, filter: "", pinnedOnly: false, open: OPEN_GROUPS(), saveOpen: false, saving: false, disk: null, fresh: false });

export const useThemeEditorStore = create<ThemeEditorState>()(closed);

/** A user theme's file, from its Theme (the fields the file format has). */
function fileOf(t: Theme): UserThemeFile {
  return {
    id: t.id,
    name: t.name,
    scheme: t.scheme,
    ...(t.pair ? { pair: t.pair } : {}),
    source: t.source,
    base: t.base,
    ...(t.overrides && Object.keys(t.overrides).length ? { overrides: t.overrides } : {}),
    from: t.from ?? "",
    createdBy: t.createdBy ?? "",
    path: (t as Theme & { path?: string }).path ?? "",
  };
}

/** Copies Customise has made and is about to open (markFreshCopy); startEditing takes the mark. */
const freshCopies = new Set<string>();

/** Customise: the copy `id` is about to open in this window's editor; leaving it unsaved deletes it. */
export function markFreshCopy(id: string): void {
  freshCopies.add(id);
}

let unsubDisk: (() => void) | null = null;

/** The last unsaved copy's delete (stopEditing); leaveEditor waits for it. */
let discarding: Promise<void> = Promise.resolve();

/** Starts editing one of the user's themes (theme.edit's view). False for an unknown or curated id. */
export function startEditing(id: string): boolean {
  const t = themeById.get(id);
  if (!t?.user) return false;
  const file = fileOf(t);
  const fresh = freshCopies.delete(id);
  useThemeEditorStore.setState({ ...closed(), id, saved: file, draft: file, basis: pinBasis(file), fresh });
  // Later saves of the file (a thread, the CLI, another window) reach the open editor.
  unsubDisk?.();
  unsubDisk = subscribeUserThemes(syncFromDisk);
  return true;
}

/**
 * Ends edit mode, dropping the draft. A copy Customise made that was never saved is
 * deleted (`keepCopy`: it is already gone, or the caller deletes it).
 */
export function stopEditing(opts: { keepCopy?: boolean } = {}): void {
  const s = useThemeEditorStore.getState();
  if (s.id === null) return;
  unsubDisk?.();
  unsubDisk = null;
  useThemeEditorStore.setState(closed());
  if (s.fresh && !opts.keepCopy) discarding = discardCopy(s.id);
}

/**
 * Deletes an unsaved Customise copy as the editor closes on it, without asking (the user
 * never saved it). Kept when a slot uses it by now, or when it is gone already.
 */
async function discardCopy(id: string): Promise<void> {
  const slots = themeSlots();
  if (slots.dark === id || slots.light === id || !themeById.get(id)?.user) return;
  try {
    await invokeCommand("theme.delete", getUiContext(), { theme: id }, undefined, { confirmed: true });
  } catch (err) {
    console.warn(`theme editor: the unsaved copy ${id} was not deleted`, err);
  }
}

const fileKey = (f: UserThemeFile | null) => (f ? JSON.stringify(themeFileJson(f)) : "");

/**
 * The open theme's file changed in the user's themes (an event): the same as the draft, it
 * is now the saved file; a clean editor reloads it (saved and draft, the pins' basis
 * taken again); with unsaved edits it waits in `disk` for Reload or Keep mine. A file
 * that went away leaves the editor on its draft (Save writes it again).
 */
export function syncFromDisk(): void {
  const s = useThemeEditorStore.getState();
  if (s.id === null) return;
  const t = themeById.get(s.id);
  if (!t?.user) return;
  const file = fileOf(t);
  const key = fileKey(file);
  if (key === fileKey(s.saved)) {
    if (s.disk) useThemeEditorStore.setState({ disk: null });
    return;
  }
  // Someone else wrote it (or this window's Save landed): a copy that has a file of its own now.
  if (key === fileKey(s.draft)) useThemeEditorStore.setState({ saved: file, disk: null, fresh: false });
  else if (!editorDirty(s)) useThemeEditorStore.setState({ saved: file, draft: file, basis: pinBasis(file), disk: null, fresh: false });
  else useThemeEditorStore.setState({ disk: file, fresh: false });
}

/** "Changed on disk · Reload": the newer file replaces the draft. */
export function reloadFromDisk(): void {
  useThemeEditorStore.setState((s) => (s.disk ? { saved: s.disk, draft: s.disk, basis: pinBasis(s.disk), disk: null } : s));
}

/** "Changed on disk · Keep mine": the draft stays (Save overwrites the newer file); Revert goes back to the newer file. */
export function keepMine(): void {
  useThemeEditorStore.setState((s) => (s.disk ? { saved: s.disk, disk: null } : s));
}

/** The draft differs from the saved file. */
export function editorDirty(s: Pick<ThemeEditorState, "draft" | "saved"> = useThemeEditorStore.getState()): boolean {
  return s.draft !== s.saved && fileKey(s.draft) !== fileKey(s.saved);
}

/**
 * Leaves edit mode: at once when nothing changed, else after the confirm dialog. Resolves
 * whether the editor is closed now. `why` replaces the question's second sentence.
 */
export async function leaveEditor(why = "Leave the editor and drop them?"): Promise<boolean> {
  const s = useThemeEditorStore.getState();
  if (s.id === null) return true;
  if (editorDirty(s)) {
    const name = s.draft?.name ?? s.id;
    const yes = await requestConfirm({ title: "Discard changes?", message: `${name} has changes that are not saved. ${why}`, confirmLabel: "Discard" });
    if (!yes) return false;
  }
  stopEditing();
  // An unsaved Customise copy is gone before what comes next (another Customise must not number around it).
  await discarding;
  return true;
}

/** Runs next once the editor is closed (asking first when it has changes); stay when the user stays. */
export function afterLeavingEditor(next: () => void, stay?: () => void): void {
  if (useThemeEditorStore.getState().id === null) {
    next();
    return;
  }
  void leaveEditor().then((ok) => {
    if (ok) next();
    else stay?.();
  });
}

function setDraft(edit: (d: UserThemeFile) => UserThemeFile, basis?: (b: Readonly<Record<string, string>>, d: UserThemeFile) => Readonly<Record<string, string>>): void {
  useThemeEditorStore.setState((s) => {
    if (!s.draft) return s;
    const draft = edit(s.draft);
    return { draft, basis: basis ? basis(s.basis, s.draft) : s.basis };
  });
}

/** Sets a base colour (undefined clears an optional one); every slot derived from it follows, pins keep their values. */
export function setBaseColour(key: BaseKey, value: string | undefined): void {
  setDraft((d) => ({ ...d, base: withBase(d.base, key, value) }));
}

/** Pins a slot at a value (touching a slot pins it). Its basis is what it derived just before, unless it was pinned already. */
export function pinSlot(name: string, value: string): void {
  setDraft(
    (d) => ({ ...d, overrides: { ...d.overrides, [name]: value } }),
    (b, before) => (name in b ? b : { ...b, [name]: derivedValue(before, name) }),
  );
}

/** Unpins a slot: it follows its rule again. */
export function unpinSlot(name: string): void {
  setDraft(
    (d) => {
      const next = withoutPin(d, name);
      return next.overrides && Object.keys(next.overrides).length === 0 ? (({ overrides: _o, ...rest }) => rest)(next) : next;
    },
    (b) => {
      const { [name]: _gone, ...rest } = b;
      return rest;
    },
  );
}

/** Reset to derived: the pin takes the value the rule gives now (and is no longer stale). */
export function resetSlotToDerived(name: string): void {
  const d = useThemeEditorStore.getState().draft;
  if (!d) return;
  const value = derivedValue(d, name);
  setDraft(
    (x) => ({ ...x, overrides: { ...x.overrides, [name]: value } }),
    (b) => ({ ...b, [name]: value }),
  );
}

/** The save modal's Fix for a failing slot (fixContrast): unpins it, or pins the stepped value; a slot no value mends is left alone. */
export function fixSlotContrast(name: string): void {
  const d = useThemeEditorStore.getState().draft;
  if (!d) return;
  const fix = fixContrast(d, name);
  if (fix?.kind === "unpin") unpinSlot(name);
  else if (fix?.kind === "pin") pinSlot(name, fix.value);
}

/** Revert: back to the saved file (or to the newer one on disk, when one is waiting). */
export function revertEdits(): void {
  useThemeEditorStore.setState((s) => {
    const to = s.disk ?? s.saved;
    return to ? { saved: to, draft: to, basis: pinBasis(to), disk: null, view: { kind: "list" } } : s;
  });
}

export function showEditorView(view: EditorView): void {
  useThemeEditorStore.setState({ view });
}

/** Escape in the editor: a slot or base view goes back to the list. True when it did. */
export function editorBack(): boolean {
  const s = useThemeEditorStore.getState();
  if (s.id === null || s.view.kind === "list" || s.saveOpen) return false;
  useThemeEditorStore.setState({ view: { kind: "list" } });
  return true;
}

export function setEditorFilter(filter: string): void {
  useThemeEditorStore.setState({ filter });
}

export function setPinnedOnly(pinnedOnly: boolean): void {
  useThemeEditorStore.setState({ pinnedOnly });
}

/** Expands or collapses a slot group (or "terminal-base"). */
export function toggleEditorGroup(group: SlotGroup | "terminal-base", open: boolean): void {
  useThemeEditorStore.setState((s) => ({ open: { ...s.open, [group]: open } }));
}

export function setSaveOpen(saveOpen: boolean): void {
  useThemeEditorStore.setState({ saveOpen });
}

/**
 * Save: writes the draft through theme.save (`--data`, the file as JSON; the same id, so a
 * new name is a rename), and with `apply` makes it the theme of its scheme (theme.save's
 * `apply`, the setting theme.set-dark / theme.set-light write). The draft becomes the
 * saved file; the editor stays open.
 */
export async function saveEdits(opts: { name: string; apply: boolean }): Promise<boolean> {
  const s = useThemeEditorStore.getState();
  if (!s.draft || s.saving) return false;
  const name = opts.name.trim() || s.draft.name;
  const file: UserThemeFile = { ...s.draft, name };
  useThemeEditorStore.setState({ saving: true });
  const res = await runCommandForResult("theme.save", { data: JSON.stringify(themeFileJson(file)), ...(opts.apply ? { apply: "true" } : {}) }, { quiet: true });
  useThemeEditorStore.setState((cur) => (res && cur.id === file.id ? { saving: false, saveOpen: false, saved: file, draft: file, disk: null, fresh: false } : { saving: false }));
  if (res) toast.success(opts.apply ? `Saved ${name} and made it your ${file.scheme} theme` : `Saved ${name}`);
  return res !== null;
}

// ---------------------------------------------------------------- derived data

/** What the inspector shows of a draft: its resolved slots, the contrast report and the stale pins, by slot. */
export interface EditorAnalysis {
  readonly theme: Theme;
  readonly slots: Readonly<Record<string, string>>;
  readonly report: readonly ContrastEntry[];
  /** Failing pairs by the slot drawn on top. */
  readonly failing: ReadonlyMap<string, readonly ContrastEntry[]>;
  readonly stale: readonly StalePin[];
  readonly staleBySlot: ReadonlyMap<string, StalePin>;
  readonly pinned: number;
  /** Why the daemon would refuse the draft (draftRefusal), or null: Save is held while it stands. */
  readonly refusal: Refusal | null;
}

/** A rule of the file format the draft breaks; `scheme` is its surface against its scheme. */
export interface Refusal {
  readonly kind: "scheme" | "file";
  readonly message: string;
}

/** The editor's words for a surface its scheme cannot carry (the rule is schemeProblem's; the editor has no scheme control). */
export function schemeRefusal(scheme: ThemeScheme, surface: string): string | null {
  if (!schemeProblem(scheme, surface)) return null;
  const L = lightness(surface).toFixed(2);
  return scheme === "dark"
    ? `A dark theme needs a dark surface (OKLab lightness at most ${String(SCHEME_LIGHTNESS.darkMax)}); ${surface} is ${L}. Darken the surface to save.`
    : `A light theme needs a light surface (OKLab lightness at least ${String(SCHEME_LIGHTNESS.lightMin)}); ${surface} is ${L}. Lighten the surface to save.`;
}

/**
 * What theme.save would refuse in the draft (with `name` for the one being typed): the
 * file rules the daemon runs (parseThemeFile in user mode is the GUI's copy of them), so
 * the editor says it first. null when the file reads.
 */
export function draftRefusal(draft: UserThemeFile, name = draft.name): Refusal | null {
  try {
    parseThemeFile(themeFileJson({ ...draft, name }), { user: true });
    return null;
  } catch (err) {
    const scheme = schemeRefusal(draft.scheme, draft.base.surface);
    if (scheme) return { kind: "scheme", message: scheme };
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "file", message: message.startsWith(`${draft.id}: `) ? message.slice(draft.id.length + 2) : message };
  }
}

let memo: { draft: UserThemeFile; basis: Readonly<Record<string, string>>; analysis: EditorAnalysis } | null = null;

/** The analysis of a draft, computed once per draft and basis (each edit makes a new draft). */
export function analyse(draft: UserThemeFile, basis: Readonly<Record<string, string>>): EditorAnalysis {
  if (memo?.draft === draft && memo.basis === basis) return memo.analysis;
  const theme = themeOf(draft);
  const slots = theme.slots;
  const report = contrastReport(draft, slots);
  const failing = new Map<string, ContrastEntry[]>();
  for (const r of report) failing.set(r.slot, [...(failing.get(r.slot) ?? []), r]);
  const stale = staleOverrides(draft, basis);
  const analysis: EditorAnalysis = { theme, slots, report, failing, stale, staleBySlot: new Map(stale.map((p) => [p.slot, p])), pinned: Object.keys(draft.overrides ?? {}).length, refusal: draftRefusal(draft) };
  memo = { draft, basis, analysis };
  return analysis;
}

/** The draft's analysis, or null outside edit mode. Re-renders on each edit only. */
export function useEditorAnalysis(): EditorAnalysis | null {
  return useThemeEditorStore((s) => (s.draft ? analyse(s.draft, s.basis) : null));
}
