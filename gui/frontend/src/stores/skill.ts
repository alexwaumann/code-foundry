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
  type InstalledSkillView,
  type SkillEntryView,
  type SkillKindView,
  type SkillQuery,
  type SkillRegistriesView,
  type SkillSearchView,
  type SkillTierView,
} from "@/api/skill";
import { revealShell } from "./bottomActions";
import { runCommandForResult } from "./commands";
import { getUiContext } from "./context";

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

/** How many hits a search asks for (the list is virtualised; the daemon caps it at 500). */
export const SKILL_SEARCH_LIMIT = 200;

/** skill.setup's refusal with no thread or project in the context (the button's tooltip). */
export const NO_SETUP_OWNER = "select a thread or project first";

export interface SkillMarketplaceState {
  /** The search the Browse section shows (searchSkills sets it). */
  query: SkillQuery;
  /** The answer to `query`; null before the first one. A newer query's answer replaces it, an older one is dropped. */
  search: SkillSearchView | null;
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
  search: (q: SkillQuery, limit: number, signal?: AbortSignal) => Promise<SkillSearchView>;
  installed: (signal?: AbortSignal) => Promise<InstalledListView>;
  registries: (signal?: AbortSignal) => Promise<SkillRegistriesView>;
  run: (name: string, args: Record<string, string>, opts: { ctx?: UiContextView; onError?: (message: string) => void }) => Promise<InvokeResultView | null>;
  context: () => UiContextView;
  /** Opens a setup terminal in its owner's bottom panel (stores/bottomActions.ts revealShell). */
  reveal: (terminalId: string) => void;
  /** How long an epoch waits before the re-read (a burst re-reads once). */
  reloadDelayMs: number;
}

const defaultDeps: SkillMarketplaceDeps = {
  search: (q, limit, signal) => apiSearchSkills(q, limit, signal),
  installed: (signal) => listInstalledSkills(signal),
  registries: (signal) => listSkillRegistries(signal),
  run: (name, args, opts) => runCommandForResult(name, args, opts),
  context: () => getUiContext(),
  reveal: (id) => void revealShell(id),
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
  openCount = 0;
  useSkillMarketplaceStore.setState(initial, true);
}

// ---------------------------------------------------------------------------------------
// Reads

let searchSeq = 0;
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

async function runSearch(): Promise<void> {
  const seq = ++searchSeq;
  searchAbort?.abort();
  const abort = new AbortController();
  searchAbort = abort;
  const q = useSkillMarketplaceStore.getState().query;
  useSkillMarketplaceStore.setState({ searching: true });
  try {
    const search = await deps.search(q, SKILL_SEARCH_LIMIT, abort.signal);
    if (seq === searchSeq) useSkillMarketplaceStore.setState({ search, searching: false, searchError: "" });
  } catch (err) {
    if (seq === searchSeq && !isAbort(err)) useSkillMarketplaceStore.setState({ searching: false, searchError: errorMessage(err) });
  } finally {
    if (searchAbort === abort) searchAbort = null;
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

/**
 * Runs one skill.* command for a row: busy while it runs, its failure kept under the row
 * (and toasted), a re-read after it. Null when it failed or the user declined a confirm.
 * A row already busy is left alone (null).
 */
async function act(item: SkillItemRef, action: SkillAction, args: Record<string, string>, ctx?: UiContextView): Promise<InvokeResultView | null> {
  const key = skillItemKey(item.kind, item.name, item.registry);
  if (useSkillMarketplaceStore.getState().busy[key]) return null;
  setBusy(key, action);
  let failure = "";
  try {
    const res = await deps.run(`skill.${action}`, args, { ...(ctx ? { ctx } : {}), onError: (m) => (failure = m) });
    useSkillMarketplaceStore.setState((s) => ({ failures: applySkillFailure(s.failures, key, res === null && failure ? { action, message: failure } : null) }));
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

/** Disables (the daemon asks first, with the restart warning). */
export async function disableSkill(item: SkillItemRef): Promise<boolean> {
  return (await act(item, "disable", nameKind(item))) !== null;
}

/** Updates to the marketplace's version (a missing skill is reinstalled). */
export async function updateSkill(item: SkillItemRef): Promise<boolean> {
  return (await act(item, "update", nameKind(item))) !== null;
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
 * Runs a skill's setup script in a bottom-panel terminal of the context's thread or
 * project (skill.setup; it takes no kind: only skills have setup). Returns the
 * terminal's id, null when it failed. reveal opens that panel (and leaves Settings).
 */
export async function runSkillSetup(item: SkillItemRef, opts: { reveal?: boolean } = {}): Promise<string | null> {
  const res = await act(item, "setup", { name: item.name }, deps.context());
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

/**
 * The actions an Installed row offers, in the row's order: a local skill only Remove; a
 * missing one Update (reinstall) and Uninstall; otherwise Enable or Disable, Update when
 * offered, Run setup when it needs it, Uninstall.
 */
export function installedActions(r: Pick<InstalledSkillView, "state" | "enabled" | "update" | "needsSetup" | "kind">): SkillAction[] {
  if (r.state === "local") return ["remove"];
  if (r.state === "missing") return ["update", "uninstall"];
  const out: SkillAction[] = [r.enabled ? "disable" : "enable"];
  if (r.update) out.push("update");
  if (r.kind === "skill" && r.needsSetup) out.push("setup");
  out.push("uninstall");
  return out;
}

// ---------------------------------------------------------------------------------------
// Narrow selectors

export const useSkillQuery = (): SkillQuery => useSkillMarketplaceStore((s) => s.query);
export const useSkillSearch = (): SkillSearchView | null => useSkillMarketplaceStore((s) => s.search);
export const useSkillSearching = (): boolean => useSkillMarketplaceStore((s) => s.searching);
export const useSkillSearchError = (): string => useSkillMarketplaceStore((s) => s.searchError);
export const useInstalledSkills = (): InstalledListView | null => useSkillMarketplaceStore((s) => s.installed);
export const useInstalledSkillsError = (): string => useSkillMarketplaceStore((s) => s.installedError);
export const useSkillRegistries = (): SkillRegistriesView | null => useSkillMarketplaceStore((s) => s.registries);
export const useSkillRegistriesError = (): string => useSkillMarketplaceStore((s) => s.registriesError);
export const useSkillRefreshing = (): boolean => useSkillMarketplaceStore((s) => s.refreshing);
/** What is being done to one row (by skillItemKey), null when nothing. */
export const useSkillBusy = (key: string): SkillAction | null => useSkillMarketplaceStore((s) => s.busy[key] ?? null);
/** One row's last failure (by skillItemKey), null when none. */
export const useSkillFailure = (key: string): SkillFailure | null => useSkillMarketplaceStore((s) => s.failures[key] ?? null);
