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
 *   still empty): the tab is the space's empty composer again, or closes when there is one.
 * - The drafts' text is kept in localStorage (STORAGE_KEY) and put back at start, so a draft
 *   survives closing its tab and a reload. A draft the layout no longer lists (sent, discarded,
 *   cleared, from any window or the CLI) loses its text here too.
 *
 * Attachments are not kept across a reload (their files are not), as for every composer.
 */
import { create } from "zustand";
import { DRAFT_KEY } from "@/lib/compose";
import { draftLabel } from "@/lib/draftLabel";
import { clearDraft, getDraft, isDraftEmpty, updateDraft, useComposeStore } from "@/stores/compose";
import { useLayoutStore, type LayoutState } from "@/stores/layout";
import { runLayoutCommand } from "./commands";

/** localStorage: `{ v: 1, texts: { [draftId]: text } }`. */
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

async function start(tabId: string, fromKey: string): Promise<void> {
  const id = newDraftId();
  // The text gets its own key first, and the tab reads it from there at once.
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
    useComposeStore.setState((s) => {
      const { [fromKey]: _copied, ...drafts } = s.drafts;
      return { drafts };
    });
    return;
  }
  // Refused (the tab went, an older daemon): the text goes back where it was.
  moveEntry(DRAFT_KEY + id, fromKey);
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

function scheduleClear(id: string): void {
  clearTimeout(clearTimers.get(id));
  clearTimers.set(
    id,
    setTimeout(() => {
      clearTimers.delete(id);
      if (listedLabel(useLayoutStore.getState(), id) === undefined) {
        if (isPending(id)) scheduleClear(id);
        return;
      }
      const d = useComposeStore.getState().drafts[DRAFT_KEY + id];
      // Typed into again, sent, or gone meanwhile: nothing to clear.
      if (!d || !isDraftEmpty(d) || d.phase !== "idle") return;
      void runLayoutCommand("composer.draft.clear", { draft: id }).then((res) => {
        if (res) clearDraft(DRAFT_KEY + id);
      });
    }, CLEAR_MS),
  );
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
    scheduleClear(draft);
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
  sentLabels.clear();
  usePendingStore.setState({ byTab: {} });
}

/** The drafts' text as stored; {} when there is none or it cannot be read. */
export function readStoredTexts(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { texts?: unknown } | null;
    const texts = v && typeof v.texts === "object" && v.texts !== null ? (v.texts as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(texts).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return {};
  }
}

function writeStoredTexts(texts: Record<string, string>): void {
  try {
    if (Object.keys(texts).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, texts }));
  } catch {
    // Storage blocked or full: the drafts stay for this session.
  }
}

/** The drafts' text in the compose store: id → text, empty ones left out. */
function draftTexts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, d] of Object.entries(useComposeStore.getState().drafts)) {
    if (key.startsWith(DRAFT_KEY) && d.text.trim() !== "") out[key.slice(DRAFT_KEY.length)] = d.text;
  }
  return out;
}

/** The draft ids the layout lists in any space. */
function listedIds(s: Pick<LayoutState, "spaces">): Set<string> {
  return new Set(Object.values(s.spaces).flatMap((sp) => sp.drafts.map((d) => d.id)));
}

/**
 * Puts the stored text back, then keeps it stored as it changes and drops a draft's text once the
 * layout no longer lists it (and it is not being started). Returns the stop.
 */
export function startComposerDrafts(): () => void {
  for (const [id, text] of Object.entries(readStoredTexts())) {
    if (!useComposeStore.getState().drafts[DRAFT_KEY + id]) updateDraft(DRAFT_KEY + id, { text });
  }
  let last = JSON.stringify(draftTexts());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = draftTexts();
      const json = JSON.stringify(now);
      if (json === last) return;
      last = json;
      writeStoredTexts(now);
    }, 250);
  };
  const prune = (s: LayoutState) => {
    if (!s.loaded) return;
    const listed = listedIds(s);
    const pending = new Set(Object.values(usePendingStore.getState().byTab));
    for (const key of Object.keys(useComposeStore.getState().drafts)) {
      const id = key.startsWith(DRAFT_KEY) ? key.slice(DRAFT_KEY.length) : "";
      if (id && !listed.has(id) && !pending.has(id)) clearDraft(key);
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
  const stopCompose = useComposeStore.subscribe(persist);
  const stopLayout = useLayoutStore.subscribe(prune);
  return () => {
    stopCompose();
    stopLayout();
    clearTimeout(timer);
    // The last change is written, not lost to the timer.
    writeStoredTexts(draftTexts());
  };
}
