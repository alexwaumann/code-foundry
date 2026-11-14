/**
 * The Skills marketplace for Settings → Skills (docs/notes/skills-3-api.md): Browse's
 * search, what is installed, the marketplaces, and the actions on a row. Reads are
 * SkillService's; the daemon publishes a new epoch whenever it reads again (start-up, the
 * hourly refresh, each skill.* operation), and while a page has the marketplace open
 * (openSkillMarketplace) the store re-reads what it shows. Actions run the skill.*
 * commands (runCommandForResult), so their confirms (disable, uninstall, remove: the
 * daemon's words with the restart warning) and errors flow the normal way; a failure also
 * stays under its row until the next try or a dismiss.
 *
 * Not stores/skills.ts, which is the composer's "/" list (what Claude Code would load).
 */
import { create } from "zustand";
import type { UiContextView, InvokeResultView } from "@/api/command";
import { errorMessage, isAbort } from "@/api/stream";
import { terminalIdFromResult } from "@/api/terminal";
import {
  EMPTY_SKILL_QUERY,
  listInstalledSkills,
  listSkillRegistries,
  searchSkills as apiSearchSkills,
  skillCommandName,
  skillItemKey,
  type InstalledListView,
  type SkillEntryView,
  type SkillKindView,
  type SkillQuery,
  type SkillRegistriesView,
  type SkillSearchView,
  type SkillTierView,
} from "@/api/skill";
import { showTerminal } from "@/shell/terminalActions";
import { useViewsStore } from "./views";
import { runCommandForResult } from "./commands";
import { getUiContext } from "./context";

/** The daemon's RestartWarning (internal/command/commands_skill.go): disable, uninstall and remove say it. */
export const RESTART_WARNING = "Threads that are running keep it until they restart. New threads pick this up at once.";

/** What a row can have done to it. */
export type SkillAction = "install" | "enable" | "disable" | "update" | "uninstall" | "remove" | "setup";

/** A failed action, shown under its row (the daemon's words). */
export interface SkillFailure {
  action: SkillAction;
  message: string;
}

/** What an action needs of a row: a Browse entry and an installed row both are one. */
export interface SkillItemRef {
  kind: SkillKindView;
  name: string;
  registry: string;
}

/** How many hits a page of a search asks for (the list is virtualised). */
export const SKILL_SEARCH_LIMIT = 200;
/** The most hits the daemon gives in one page. */
const SKILL_PAGE_MAX = 500;

/** skill.setup's refusal with no thread or project in the context (the button's tooltip). */
export const NO_SETUP_OWNER = "select a thread or project first";

export interface SkillMarketplaceState {
  /** The search the Browse section shows (searchSkills sets it). */
  query: SkillQuery;
  /** The answer to `query`; null before the first one. A newer query's answer replaces it, an older one is dropped. */
  search: SkillSearchView | null;
  /** The next page is on its way. */
  loadingMore: boolean;
  /** Why the next page did not come. */
  loadMoreError: string;
  /** The words `search` answers: "" while it is still the whole marketplace, so a first search is not shown those hits as its own. */
  searchedText: string;
  searching: boolean;
  /** Search itself failed (the daemon, not a marketplace: those report in registries). */
  searchError: string;
  installed: InstalledListView | null;
  installedError: string;
  registries: SkillRegistriesView | null;
  registriesError: string;
  /** skill.refresh is running (the Registries section's Refresh). */
  refreshing: boolean;
  /** The last epoch the daemon announced. */
  epoch: number;
  /** What the GUI is doing to a row right now, by skillItemKey. */
  busy: Readonly<Record<string, SkillAction>>;
  /** The last failed action per row, by skillItemKey, until the next try or a dismiss. */
  failures: Readonly<Record<string, SkillFailure>>;
}

const initial: SkillMarketplaceState = {
  query: EMPTY_SKILL_QUERY,
  search: null,
  loadingMore: false,
  loadMoreError: "",
  searchedText: "",
  searching: false,
  searchError: "",
  installed: null,
  installedError: "",
  registries: null,
  registriesError: "",
  refreshing: false,
  epoch: 0,
  busy: {},
  failures: {},
};

export const useSkillMarketplaceStore = create<SkillMarketplaceState>()(() => initial);

/** What the store calls out to; tests replace it (setSkillMarketplaceDeps). */
export interface SkillMarketplaceDeps {
  search: (q: SkillQuery, limit: number, offset: number, signal?: AbortSignal) => Promise<SkillSearchView>;
  installed: (signal?: AbortSignal) => Promise<InstalledListView>;
  registries: (signal?: AbortSignal) => Promise<SkillRegistriesView>;
  run: (name: string, args: Record<string, string>, opts: { ctx?: UiContextView; quiet?: boolean; onError?: (message: string) => void }) => Promise<InvokeResultView | null>;
  context: () => UiContextView;
  /** Shows a setup terminal: its tab takes the focus, over any open sheet (Settings). */
  reveal: (terminalId: string) => void;
  /** How long an epoch waits before the re-read (a burst re-reads once). */
  reloadDelayMs: number;
}

const defaultDeps: SkillMarketplaceDeps = {
  search: (q, limit, offset, signal) => apiSearchSkills(q, limit, offset, signal),
  installed: (signal) => listInstalledSkills(signal),
  registries: (signal) => listSkillRegistries(signal),
  run: (name, args, opts) => runCommandForResult(name, args, opts),
  context: () => getUiContext(),
  reveal: (id) => {
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    void showTerminal(id);
  },
  reloadDelayMs: 100,
};

let deps = defaultDeps;

/** Replaces the store's dependencies (tests); null restores the real ones and resets the state. */
export function setSkillMarketplaceDeps(d: Partial<SkillMarketplaceDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
  if (!d) resetSkillMarketplace();
}

/** Back to nothing read (tests; a page never needs it). */
export function resetSkillMarketplace(): void {
  clearTimeout(reloadTimer);
  searchAbort?.abort();
  searchAbort = null;
  searchSeq++;
  answered = null;
  openCount = 0;
  useSkillMarketplaceStore.setState(initial, true);
}

// ---------------------------------------------------------------------------------------
// Reads

let searchSeq = 0;
/** The query `search` answers: a read of the same one keeps every page loaded. */
let answered: SkillQuery | null = null;
let searchAbort: AbortController | null = null;

/**
 * Searches Browse: text (every word must match a name, description, keyword or by) and
 * the chips (tier, kind; "" for any). Runs at once, so the page debounces its input
 * (150 ms); an answer to an older query is dropped, and the request in flight for one
 * is aborted. The previous hits stay on screen until the new ones arrive.
 */
export async function searchSkills(text: string, tier: SkillTierView = "", kind: SkillKindView | "" = ""): Promise<void> {
  useSkillMarketplaceStore.setState({ query: { text, tier, kind } });
  return runSearch();
}

/** The first `want` hits, a page at a time; short of that if the marketplace was read again meanwhile. */
async function readHits(q: SkillQuery, want: number, signal: AbortSignal): Promise<SkillSearchView> {
  let read = await deps.search(q, Math.min(want, SKILL_PAGE_MAX), 0, signal);
  while (read.entries.length < Math.min(want, read.total)) {
    const page = await deps.search(q, Math.min(want - read.entries.length, SKILL_PAGE_MAX), read.entries.length, signal);
    if (page.entries.length === 0 || page.epoch !== read.epoch) break;
    read = { ...page, entries: [...read.entries, ...page.entries] };
  }
  return read;
}

async function runSearch(want = SKILL_SEARCH_LIMIT): Promise<void> {
  const seq = ++searchSeq;
  searchAbort?.abort();
  const abort = new AbortController();
  searchAbort = abort;
  const { query: q, search: held } = useSkillMarketplaceStore.getState();
  // A read again of the same query keeps what is loaded: the list stays under the scroll.
  const again = answered !== null && answered.text === q.text && answered.tier === q.tier && answered.kind === q.kind;
  useSkillMarketplaceStore.setState({ searching: true });
  try {
    const search = await readHits(q, Math.max(want, again ? (held?.entries.length ?? 0) : 0), abort.signal);
    if (seq === searchSeq) {
      answered = q;
      useSkillMarketplaceStore.setState({ search, searchedText: q.text, searching: false, searchError: "" });
    }
  } catch (err) {
    if (seq === searchSeq && !isAbort(err)) useSkillMarketplaceStore.setState({ searching: false, searchError: errorMessage(err) });
  } finally {
    if (searchAbort === abort) searchAbort = null;
  }
}

/**
 * The next page of the search on show, after what is loaded (the list's last line asks
 * when it scrolls into view). A page from another read of the marketplace would skip or
 * repeat hits, so that reads the list again instead.
 */
export async function loadMoreSkills(): Promise<void> {
  const { search: held, query: q, searching, loadingMore } = useSkillMarketplaceStore.getState();
  if (!held || searching || loadingMore || held.entries.length >= held.total) return;
  const seq = searchSeq;
  const abort = new AbortController();
  searchAbort = abort;
  useSkillMarketplaceStore.setState({ loadingMore: true, loadMoreError: "" });
  try {
    const page = await deps.search(q, SKILL_SEARCH_LIMIT, held.entries.length, abort.signal);
    if (seq !== searchSeq) return;
    if (page.epoch !== held.epoch) void runSearch(held.entries.length + SKILL_SEARCH_LIMIT);
    else useSkillMarketplaceStore.setState({ search: { ...page, entries: [...held.entries, ...page.entries] } });
  } catch (err) {
    if (seq === searchSeq && !isAbort(err)) useSkillMarketplaceStore.setState({ loadMoreError: errorMessage(err) });
  } finally {
    if (searchAbort === abort) searchAbort = null;
    useSkillMarketplaceStore.setState({ loadingMore: false });
  }
}

async function loadInstalled(): Promise<void> {
  try {
    const installed = await deps.installed();
    useSkillMarketplaceStore.setState({ installed, installedError: "" });
  } catch (err) {
    useSkillMarketplaceStore.setState({ installedError: errorMessage(err) });
  }
}

async function loadRegistries(): Promise<void> {
  try {
    const registries = await deps.registries();
    useSkillMarketplaceStore.setState({ registries, registriesError: "" });
  } catch (err) {
    useSkillMarketplaceStore.setState({ registriesError: errorMessage(err) });
  }
}

let reloading: Promise<void> | null = null;
let again = false;

/** Whether reloadSkills was called while it read (set from outside the loop). */
function askedAgain(): boolean {
  return again;
}

/**
 * Reads Installed, Registries and the current search again. A call while one runs runs
 * once more after it (it may have read before the change it is called for).
 */
export async function reloadSkills(): Promise<void> {
  if (reloading) {
    again = true;
    return reloading;
  }
  const run = (async () => {
    for (let more = true; more; more = askedAgain()) {
      again = false;
      await Promise.all([loadInstalled(), loadRegistries(), runSearch()]);
    }
  })().finally(() => {
    reloading = null;
  });
  reloading = run;
  return run;
}

let openCount = 0;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A page shows the marketplace: read everything now, and again whenever the daemon
 * announces a new epoch, until the returned function runs (the page unmounts). Nested
 * opens count.
 */
export function openSkillMarketplace(): () => void {
  openCount++;
  void reloadSkills();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) clearTimeout(reloadTimer);
  };
}

/** Re-reads soon (a burst of epochs, or an action's result racing its epoch, reads once). */
function scheduleReload(): void {
  if (openCount === 0) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void reloadSkills(), deps.reloadDelayMs);
}

/** The EventService skill source: the daemon read again. An open page re-reads. */
export function onSkillEpoch(epoch: number): void {
  if (epoch === useSkillMarketplaceStore.getState().epoch) return;
  useSkillMarketplaceStore.setState({ epoch });
  scheduleReload();
}

// ---------------------------------------------------------------------------------------
// Actions

function setBusy(key: string, action: SkillAction | null): void {
  useSkillMarketplaceStore.setState((s) => {
    const { [key]: _gone, ...busy } = s.busy;
    return { busy: action ? { ...busy, [key]: action } : busy };
  });
}

/** The failures after an action on key: a failure replaces the last, success (or a declined confirm) clears it. Pure. */
export function applySkillFailure(s: Readonly<Record<string, SkillFailure>>, key: string, failure: SkillFailure | null): Record<string, SkillFailure> {
  const { [key]: _gone, ...rest } = s;
  return failure ? { ...rest, [key]: failure } : rest;
}

/** Takes a failure away from under its row. */
export function dismissSkillFailure(key: string): void {
  useSkillMarketplaceStore.setState((s) => (key in s.failures ? { failures: applySkillFailure(s.failures, key, null) } : {}));
}

/** An installed row as a switch left it, until the re-read says so too (or the switch would flick back in between). */
function markEnabled(key: string, enabled: boolean): void {
  useSkillMarketplaceStore.setState((s) => (s.installed ? { installed: { ...s.installed, installed: s.installed.installed.map((r) => (r.key === key ? { ...r, enabled } : r)) } } : {}));
}

/**
 * Runs one skill.* command for a row: busy while it runs, its failure kept under the row
 * (and toasted), a re-read after it. Null when it failed or the user declined a confirm.
 * A row already busy is left alone (null). `quiet` skips the success toast (the caller says it).
 */
async function act(item: SkillItemRef, action: SkillAction, args: Record<string, string>, opts: { ctx?: UiContextView; quiet?: boolean } = {}): Promise<InvokeResultView | null> {
  const key = skillItemKey(item.kind, item.name, item.registry);
  if (useSkillMarketplaceStore.getState().busy[key]) return null;
  setBusy(key, action);
  let failure = "";
  try {
    const res = await deps.run(`skill.${action}`, args, { ...opts, onError: (m) => (failure = m) });
    useSkillMarketplaceStore.setState((s) => ({ failures: applySkillFailure(s.failures, key, res === null && failure ? { action, message: failure } : null) }));
    if (res !== null && (action === "enable" || action === "disable")) markEnabled(key, action === "enable");
    if (res !== null) scheduleReload();
    return res;
  } finally {
    setBusy(key, null);
  }
}

/** The name and kind every action on a plugin or skill passes (the kind always, so a shared name never asks). */
function nameKind(item: SkillItemRef): Record<string, string> {
  return { name: skillCommandName(item.kind, item.name, item.registry), kind: item.kind };
}

/** Installs a Browse entry: claude plugin install, or a copy into ~/.claude/skills. */
export async function installSkill(item: SkillItemRef): Promise<boolean> {
  return (await act(item, "install", nameKind(item))) !== null;
}

export async function enableSkill(item: SkillItemRef): Promise<boolean> {
  return (await act(item, "enable", nameKind(item))) !== null;
}

/** Disables (the daemon asks first, with the restart warning). `quiet`: no success toast. */
export async function disableSkill(item: SkillItemRef, opts: { quiet?: boolean } = {}): Promise<boolean> {
  return (await act(item, "disable", nameKind(item), opts)) !== null;
}

/** Updates to the marketplace's version (a missing skill is reinstalled). `quiet`: no success toast (an Update all's row says it). */
export async function updateSkill(item: SkillItemRef, opts: { quiet?: boolean } = {}): Promise<boolean> {
  return (await act(item, "update", nameKind(item), opts)) !== null;
}

/** Uninstalls a plugin or a skill Code Foundry installed (the daemon asks first, with the restart warning). */
export async function uninstallSkill(item: SkillItemRef): Promise<boolean> {
  return (await act(item, "uninstall", nameKind(item))) !== null;
}

/** Deletes a local skill's directory (skill.remove; the daemon asks first, naming it). It takes no kind: only skills are local. */
export async function removeLocalSkill(item: SkillItemRef): Promise<boolean> {
  return (await act(item, "remove", { name: item.name })) !== null;
}

/** Whether skill.setup has an owner for its terminal in ctx: a thread, a worktree or a project. */
export function canRunSetup(ctx: UiContextView = deps.context()): boolean {
  return Boolean(ctx.activeThreadId || ctx.activeWorktreePath || ctx.activeProjectId);
}

/**
 * Runs a skill's setup script in a terminal of the context's thread or project (skill.setup; it
 * takes no kind: only skills have setup). Returns the terminal's id, null when it failed. reveal
 * shows its tab (and leaves Settings).
 */
export async function runSkillSetup(item: SkillItemRef, opts: { reveal?: boolean } = {}): Promise<string | null> {
  const res = await act(item, "setup", { name: item.name }, { ctx: deps.context() });
  const id = res ? terminalIdFromResult(res.resultJson) : null;
  if (id && opts.reveal) deps.reveal(id);
  return id;
}

/** Updates every marketplace (skill.refresh: claude plugin marketplace update; network) and re-reads. */
export async function refreshSkillMarketplaces(): Promise<boolean> {
  if (useSkillMarketplaceStore.getState().refreshing) return false;
  useSkillMarketplaceStore.setState({ refreshing: true });
  try {
    const res = await deps.run("skill.refresh", {}, {});
    if (res !== null) scheduleReload();
    return res !== null;
  } finally {
    useSkillMarketplaceStore.setState({ refreshing: false });
  }
}

// ---------------------------------------------------------------------------------------
// What a row offers (pure)

/** Browse's button for an entry: Install, Update to <updateVersion>, or Installed. */
export function browseAction(e: Pick<SkillEntryView, "state" | "updateVersion">): "install" | "update" | "installed" {
  if (e.state === "not-installed") return "install";
  return e.updateVersion ? "update" : "installed";
}

// ---------------------------------------------------------------------------------------
// Narrow selectors

export const useSkillSearching = (): boolean => useSkillMarketplaceStore((s) => s.searching);
export const useSkillSearchError = (): string => useSkillMarketplaceStore((s) => s.searchError);
export const useInstalledSkillsError = (): string => useSkillMarketplaceStore((s) => s.installedError);
export const useSkillRegistriesError = (): string => useSkillMarketplaceStore((s) => s.registriesError);
export const useSkillRefreshing = (): boolean => useSkillMarketplaceStore((s) => s.refreshing);
/** What is being done to one row (by skillItemKey), null when nothing. */
export const useSkillBusy = (key: string): SkillAction | null => useSkillMarketplaceStore((s) => s.busy[key] ?? null);
/** One row's last failure (by skillItemKey), null when none. */
export const useSkillFailure = (key: string): SkillFailure | null => useSkillMarketplaceStore((s) => s.failures[key] ?? null);
