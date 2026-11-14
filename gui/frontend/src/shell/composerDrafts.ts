/**
 * Composer drafts in the window shell (docs/notes/shell-model.md, "The composer > Drafts";
 * docs/notes/shell-2b-drafts.md, shell-16-sidebar.md). The layout knows a draft by its id, label
 * and params; its text lives in the compose store like every composer's (stores/compose.ts), under
 * its own key (lib/compose DRAFT_KEY + id), so two drafts on one project never share it.
 *
 * - The first text the user types in a space's empty composer starts a draft: the text is copied
 *   to a new id's key and `composer.draft.start --tab --id --label` makes the tab that draft (the
 *   window chooses the id, so the text has its key before the daemon answers). Until the layout
 *   shows the tab's `draft` param, the tab reads the id from here (`pendingDraft`).
 * - Later edits relabel it (`composer.draft.label`, at most every LABEL_MS, only when the label
 *   changed); deleting all its text clears it (`composer.draft.clear` after CLEAR_MS, if it is
 *   still empty): the tab is the space's empty composer again, or closes when there is one. Text
 *   typed while the clear is on its way is kept: once the layout shows the draft gone, a draft
 *   that is no longer empty starts again as a new draft on the same tab (or, its tab closed, goes
 *   to its target's composer), never dropped.
 * - The drafts' text is kept in localStorage (STORAGE_KEY) and put back at start, so a draft
 *   survives closing its tab and a reload. A draft the layout no longer lists (sent, discarded,
 *   cleared, from any window or the CLI) loses its text here too.
 * - So is the text typed in a thread's own composer and not yet sent (its compose store key,
 *   lib/threadDraft threadDraftKey, which the floating composer shares): put back at start, gone
 *   once sent (the send clears it) and dropped when the thread is archived or removed.
 *
 * Attachments are not kept across a reload (their files are not), as for every composer.
 */
import { create } from "zustand";
import { DRAFT_KEY } from "@/lib/compose";
import { draftLabel } from "@/lib/draftLabel";
import { threadDraftKey } from "@/lib/threadDraft";
import { clearDraft, getDraft, isDraftEmpty, updateDraft, useComposeStore } from "@/stores/compose";
import { useLayoutStore, type LayoutState } from "@/stores/layout";
import { useThreadsStore, type ThreadsData } from "@/stores/threads";
import { runLayoutCommand } from "./commands";

/** localStorage: `{ v: 1, texts: { [draftId]: text }, threads: { [threadId]: text } }`. */
export const STORAGE_KEY = "code-foundry.shellDrafts";
/** How often a draft's label may change while the user types. */
export const LABEL_MS = 500;
/** How long an emptied draft waits before it is cleared (typing again keeps it). */
export const CLEAR_MS = 600;

interface PendingState {
  /** Tab id → the draft id it is becoming (start sent, the layout not yet showing it). */
  byTab: Readonly<Record<string, string>>;
}

const usePendingStore = create<PendingState>()(() => ({ byTab: {} }));

/** The draft a compose tab is: its `draft` param, else the one being started for it. */
export function usePendingDraft(tabId: string): string {
  return usePendingStore((s) => s.byTab[tabId] ?? "");
}

function setPending(tabId: string, draft: string | null): void {
  usePendingStore.setState((s) => {
    const { [tabId]: _old, ...rest } = s.byTab;
    return { byTab: draft ? { ...rest, [tabId]: draft } : rest };
  });
}

function isPending(id: string): boolean {
  return Object.values(usePendingStore.getState().byTab).includes(id);
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new draft id: "d-" and 8 base32 characters, as the daemon makes them. */
export function newDraftId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `d-${Array.from(bytes, (b) => B32[b % 32] ?? "a").join("")}`;
}

/** Moves a compose store entry to another key as it is (its attachments' object URLs stay alive). */
function moveEntry(from: string, to: string): void {
  useComposeStore.setState((s) => {
    const d = s.drafts[from];
    if (!d) return s;
    const { [from]: _moved, ...drafts } = s.drafts;
    return { drafts: { ...drafts, [to]: d } };
  });
}

const labelTimers = new Map<string, ReturnType<typeof setTimeout>>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Drafts whose clear was sent and is not yet settled: id → the tab and the target key it came from. */
const clearing = new Map<string, { tabId: string; targetKey: string }>();
/** The label last sent per draft, so an unchanged one is not sent again. */
const sentLabels = new Map<string, string>();

/** The label the layout lists for a draft; undefined when no space lists it. */
function listedLabel(s: Pick<LayoutState, "spaces">, id: string): string | undefined {
  for (const sp of Object.values(s.spaces)) {
    const d = sp.drafts.find((x) => x.id === id);
    if (d) return d.label;
  }
  return undefined;
}

/**
 * Makes a compose tab a draft of the text under `fromKey`: the text gets the new draft's own key
 * at once, and `composer.draft.start` makes the tab that draft. Refused (the tab went, an older
 * daemon), the text goes to `fallbackKey` (by default where it came from).
 */
async function start(tabId: string, fromKey: string, fallbackKey = fromKey): Promise<void> {
  const id = newDraftId();
  // The text gets its own key first, and the tab reads it from there at once.
  if (fromKey.startsWith(DRAFT_KEY)) moveEntry(fromKey, DRAFT_KEY + id);
  else
    useComposeStore.setState((s) => {
      const d = s.drafts[fromKey];
      return d ? { drafts: { ...s.drafts, [DRAFT_KEY + id]: d } } : s;
    });
  setPending(tabId, id);
  const label = draftLabel(getDraft(DRAFT_KEY + id).text);
  sentLabels.set(id, label);
  const res = await runLayoutCommand("composer.draft.start", { tab: tabId, id, ...(label ? { label } : {}) });
  if (res) {
    // The target's own entry was copied; it starts empty again for the next composer.
    if (!fromKey.startsWith(DRAFT_KEY))
      useComposeStore.setState((s) => {
        const { [fromKey]: _copied, ...drafts } = s.drafts;
        return { drafts };
      });
    return;
  }
  // Refused: the text goes back.
  moveEntry(DRAFT_KEY + id, fallbackKey);
  setPending(tabId, null);
  sentLabels.delete(id);
}

function relabel(id: string): void {
  clearTimeout(labelTimers.get(id));
  labelTimers.set(
    id,
    setTimeout(() => {
      labelTimers.delete(id);
      // Its start not answered yet: ask again later.
      if (listedLabel(useLayoutStore.getState(), id) === undefined) {
        if (isPending(id)) relabel(id);
        return;
      }
      const label = draftLabel(getDraft(DRAFT_KEY + id).text);
      if (label === "" || label === sentLabels.get(id)) return;
      sentLabels.set(id, label);
      void runLayoutCommand("composer.draft.label", { draft: id, label });
    }, LABEL_MS),
  );
}

function scheduleClear(id: string, tabId: string, targetKey: string): void {
  clearTimeout(clearTimers.get(id));
  clearTimers.set(
    id,
    setTimeout(() => {
      clearTimers.delete(id);
      if (listedLabel(useLayoutStore.getState(), id) === undefined) {
        if (isPending(id)) scheduleClear(id, tabId, targetKey);
        return;
      }
      const d = useComposeStore.getState().drafts[DRAFT_KEY + id];
      // Typed into again, sent, or gone meanwhile: nothing to clear.
      if (!d || !isDraftEmpty(d) || d.phase !== "idle") return;
      clearing.set(id, { tabId, targetKey });
      void runLayoutCommand("composer.draft.clear", { draft: id }).then((res) => {
        // Refused: the draft stays as it is. Done: settled here unless the layout still lists it
        // (its event not in yet), and then when it no longer does (startComposerDrafts' prune).
        if (!res) clearing.delete(id);
        else if (listedLabel(useLayoutStore.getState(), id) === undefined) settleCleared(id);
      });
    }, CLEAR_MS),
  );
}

/**
 * A cleared draft the layout no longer lists. Still empty: its text goes. Typed into while the
 * clear was on its way: the text is a draft again, on the same tab when it is still open (the
 * space's empty composer now), else in its target's composer.
 */
function settleCleared(id: string): void {
  const from = clearing.get(id);
  if (!from) return;
  clearing.delete(id);
  const key = DRAFT_KEY + id;
  const d = useComposeStore.getState().drafts[key];
  if (!d || isDraftEmpty(d)) {
    clearDraft(key);
    return;
  }
  const tab = useLayoutStore.getState().tabs[from.tabId];
  if (tab?.kind === "compose" && !tab.params.draft && !usePendingStore.getState().byTab[from.tabId]) {
    void start(from.tabId, key, from.targetKey);
    return;
  }
  if (isDraftEmpty(getDraft(from.targetKey))) moveEntry(key, from.targetKey);
  else {
    updateDraft(from.targetKey, { text: `${getDraft(from.targetKey).text}\n\n${d.text}` });
    clearDraft(key);
  }
}

/**
 * The user changed a compose tab's text (Composer's onTextChange). `draft` is the tab's draft
 * ("" for the empty composer) and `targetKey` the compose store key of what it starts from.
 */
export function composerTextChanged(tabId: string, draft: string, targetKey: string): void {
  if (!draft) {
    const d = getDraft(targetKey);
    if (!isDraftEmpty(d) && d.phase === "idle" && !usePendingStore.getState().byTab[tabId]) void start(tabId, targetKey);
    return;
  }
  const d = getDraft(DRAFT_KEY + draft);
  if (isDraftEmpty(d)) {
    clearTimeout(labelTimers.get(draft));
    scheduleClear(draft, tabId, targetKey);
    return;
  }
  clearTimeout(clearTimers.get(draft));
  relabel(draft);
}

/** Forgets what is in flight: drafts being started, waiting labels and clears (tests). */
export function resetComposerDrafts(): void {
  for (const t of [...labelTimers.values(), ...clearTimers.values()]) clearTimeout(t);
  labelTimers.clear();
  clearTimers.clear();
  clearing.clear();
  sentLabels.clear();
  usePendingStore.setState({ byTab: {} });
}

/** What is stored: the drafts' text by draft id, and the threads' unsent text by thread id. */
export interface StoredTexts {
  texts: Record<string, string>;
  threads: Record<string, string>;
}

/** One map of the stored document, its non-empty strings only. */
function textsOf(v: unknown): Record<string, string> {
  const m = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

/** The stored text; empty maps when there is none or it cannot be read. */
export function readStored(): StoredTexts {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { texts?: unknown; threads?: unknown } | null;
    return { texts: textsOf(v?.texts), threads: textsOf(v?.threads) };
  } catch {
    return { texts: {}, threads: {} };
  }
}

/** The drafts' text as stored; {} when there is none or it cannot be read. */
export function readStoredTexts(): Record<string, string> {
  return readStored().texts;
}

function writeStored(s: StoredTexts): void {
  try {
    if (Object.keys(s.texts).length === 0 && Object.keys(s.threads).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, texts: s.texts, threads: s.threads }));
  } catch {
    // Storage blocked or full: the drafts stay for this session.
  }
}

const THREAD_KEY = threadDraftKey("");

/** The drafts' and the threads' text in the compose store: by id, empty ones left out. */
function storedTexts(): StoredTexts {
  const out: StoredTexts = { texts: {}, threads: {} };
  for (const [key, d] of Object.entries(useComposeStore.getState().drafts)) {
    if (d.text.trim() === "") continue;
    if (key.startsWith(DRAFT_KEY)) out.texts[key.slice(DRAFT_KEY.length)] = d.text;
    else if (key.startsWith(THREAD_KEY)) out.threads[key.slice(THREAD_KEY.length)] = d.text;
  }
  return out;
}

/** The draft ids the layout lists in any space. */
function listedIds(s: Pick<LayoutState, "spaces">): Set<string> {
  return new Set(Object.values(s.spaces).flatMap((sp) => sp.drafts.map((d) => d.id)));
}

/**
 * Puts the stored text back, then keeps it stored as it changes and drops a draft's text once the
 * layout no longer lists it (and it is not being started), and a thread's once the thread is
 * archived or gone. Returns the stop.
 */
export function startComposerDrafts(): () => void {
  const stored = readStored();
  for (const [id, text] of Object.entries(stored.texts)) {
    if (!useComposeStore.getState().drafts[DRAFT_KEY + id]) updateDraft(DRAFT_KEY + id, { text });
  }
  for (const [id, text] of Object.entries(stored.threads)) {
    if (!useComposeStore.getState().drafts[threadDraftKey(id)]) updateDraft(threadDraftKey(id), { text });
  }
  let last = JSON.stringify(storedTexts());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = storedTexts();
      const json = JSON.stringify(now);
      if (json === last) return;
      last = json;
      writeStored(now);
    }, 250);
  };
  // A thread archived or removed takes its unsent text with it (once the list is in: before, every thread is unknown).
  const pruneThreads = (s: Pick<ThreadsData, "byId"> & { loaded: boolean }) => {
    if (!s.loaded) return;
    for (const key of Object.keys(useComposeStore.getState().drafts)) {
      if (!key.startsWith(THREAD_KEY)) continue;
      const t = s.byId[key.slice(THREAD_KEY.length)];
      if (!t || t.archivedAtMs !== null) clearDraft(key);
    }
  };
  const prune = (s: LayoutState) => {
    if (!s.loaded) return;
    const listed = listedIds(s);
    // A clear the layout now shows done: settled before anything unlisted is dropped.
    for (const id of [...clearing.keys()]) if (!listed.has(id)) settleCleared(id);
    const pending = new Set(Object.values(usePendingStore.getState().byTab));
    for (const key of Object.keys(useComposeStore.getState().drafts)) {
      const id = key.startsWith(DRAFT_KEY) ? key.slice(DRAFT_KEY.length) : "";
      if (id && !listed.has(id) && !pending.has(id) && !clearing.has(id)) clearDraft(key);
    }
    // A tab the layout now shows as its draft needs no pending id.
    for (const [tabId, id] of Object.entries(usePendingStore.getState().byTab)) {
      if (s.tabs[tabId]?.params.draft === id || !s.tabs[tabId]) setPending(tabId, null);
    }
    for (const id of sentLabels.keys()) {
      const label = listedLabel(s, id);
      if (label === undefined && !pending.has(id)) sentLabels.delete(id);
    }
  };
  prune(useLayoutStore.getState());
  pruneThreads(useThreadsStore.getState());
  const stopCompose = useComposeStore.subscribe(persist);
  const stopLayout = useLayoutStore.subscribe(prune);
  const stopThreads = useThreadsStore.subscribe(pruneThreads);
  return () => {
    stopCompose();
    stopLayout();
    stopThreads();
    clearTimeout(timer);
    // The last change is written, not lost to the timer.
    writeStored(storedTexts());
  };
}
