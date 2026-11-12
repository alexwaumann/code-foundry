/**
 * The Needs-you inbox's window state (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-17-needs-you.md):
 * which thread's popup is open, which hover card it dismissed until its anchor is hovered again,
 * and each pending ask's detail for a card, read once without a Watch.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { readAskItems } from "@/api/threadSearch";
import type { ThreadPendingView, ThreadRequestView } from "@/api/thread";
import { contextLine, nextNeedsThread } from "@/lib/needsAsk";
import { getNeedsIds } from "./shellList";
import { useOpenRequests, useThreadStore } from "./thread";
import { useUiStore } from "./ui";

/** One ask's detail as a card reads it from the daemon (ListItems pages). */
interface AskDetail {
  request: ThreadRequestView | null;
  context: string;
}

interface NeedsState {
  /** The thread whose popup is open; null when none is. */
  popup: string | null;
  /** The hover card anchor ("sidebar:<id>", "popover:<id>", "strip:<pane>") the popup dismissed until it is hovered again. */
  dismissed: string | null;
  /** Asks read for a card, by request id; absent until read. */
  details: Readonly<Record<string, AskDetail>>;
  /** The sidebar list has the keyboard and its cursor moved by key: a Needs you row under it shows its card. */
  keyCursor: boolean;
  /** The top bar's Needs you popover is open (the sidebar collapsed); the popup closes it. */
  popover: boolean;
}

export const useNeedsStore = create<NeedsState>()(() => ({ popup: null, dismissed: null, details: {}, keyCursor: false, popover: false }));

/** The sidebar list's cursor moved by key: the row under it shows its card, even one the popup shut. */
export function needsKeyMove(): void {
  const s = useNeedsStore.getState();
  if (!s.keyCursor || s.dismissed !== null) useNeedsStore.setState({ keyCursor: true, dismissed: null });
}

/** The sidebar list lost the keyboard or took a press: no card follows its cursor. */
export function needsKeyLeave(): void {
  if (useNeedsStore.getState().keyCursor) useNeedsStore.setState({ keyCursor: false });
}

/** Opens a thread's popup; the hover card of `anchor` stays shut until that anchor is hovered again. */
export function openNeedsPopup(threadId: string, anchor: string | null = null): void {
  useNeedsStore.setState({ popup: threadId, dismissed: anchor, popover: false });
}

export function setNeedsPopover(open: boolean): void {
  useNeedsStore.setState({ popover: open });
}

export function closeNeedsPopup(): void {
  if (useNeedsStore.getState().popup !== null) useNeedsStore.setState({ popup: null });
}

/** The pointer entered an anchor again: its card may open. */
export function rehoverNeedsAnchor(anchor: string): void {
  if (useNeedsStore.getState().dismissed === anchor) useNeedsStore.setState({ dismissed: null });
}

/** Shuts a card after it acted (Allow, Deny, Go to thread), as the popup does, until it is hovered again. */
export function dismissNeedsCard(anchor: string): void {
  useNeedsStore.setState({ dismissed: anchor });
}

/**
 * cmd+shift+a in the window shell: the popup of the next thread in the Needs you list after the
 * popup's (else the focused thread), wrapping. False, and nothing visible, when none waits.
 */
export function openNextNeedsPopup(): boolean {
  const sel = useUiStore.getState().selection;
  const from = useNeedsStore.getState().popup ?? (sel.kind === "thread" ? sel.id : null);
  const next = nextNeedsThread(getNeedsIds(), from);
  if (next === null) return false;
  openNeedsPopup(next);
  return true;
}

/**
 * "Go to thread": the thread's space and its tab, focused or opened in the focused pane
 * (select(), which the selection bridge turns into thread.open --focus). The popup closes.
 */
export function goToNeedsThread(threadId: string): void {
  closeNeedsPopup();
  setNeedsPopover(false);
  useUiStore.getState().select({ kind: "thread", id: threadId }, { focusPrompt: true });
}

const reading = new Set<string>();

/** Reads an ask's item and the last line before it, once per request (a failure is retried on the next open). */
function readDetail(threadId: string, p: ThreadPendingView): void {
  if (reading.has(p.requestId) || p.requestId in useNeedsStore.getState().details) return;
  reading.add(p.requestId);
  void readAskItems(threadId, p.itemId)
    .then(({ ask, replies }) => {
      const request = ask && (ask.kind === "permission" || ask.kind === "question") ? ask.request : null;
      const context = contextLine(replies, ask?.ordinal ?? null);
      useNeedsStore.setState((s) => ({ details: { ...s.details, [p.requestId]: { request, context } } }));
    })
    .catch(() => undefined)
    .finally(() => {
      reading.delete(p.requestId);
    });
}

/** Forgets every read detail (tests). */
export function resetNeeds(): void {
  reading.clear();
  useNeedsStore.setState({ popup: null, dismissed: null, details: {}, keyCursor: false, popover: false });
}

/** What a hover card shows of a thread's ask. */
export interface AskView {
  /** The oldest open request (summary from the thread source); null for an ask with none (a woken snooze, a plugin's flag). */
  pending: ThreadPendingView | null;
  /** How many requests are open. */
  count: number;
  /** The request whole once known: from the thread's log when a view holds its Watch, else read once. */
  request: ThreadRequestView | null;
  /** The last line Claude wrote before the ask; "" for none or not read yet. */
  context: string;
}

/** The last text line before an item in a log, scanning back from its end. */
function logContext(threadId: string, askItemId: string): (s: ReturnType<typeof useThreadStore.getState>) => string | null {
  return (s) => {
    const log = s.logs[threadId];
    if (!log || !(threadId in s.synced)) return null;
    const ask = log.byId[askItemId];
    const items = [];
    for (let i = log.order.length - 1; i >= 0 && items.length < 40; i--) {
      const it = log.byId[log.order[i] ?? ""];
      if (it?.kind === "text") items.push(it);
    }
    return contextLine(items, ask?.ordinal ?? null);
  };
}

/** A thread's ask for a card; `read` fetches its detail when no Watch has it (the card is open). */
export function useAskView(threadId: string, read: boolean): AskView {
  const open = useOpenRequests(threadId);
  const pending = open[0] ?? null;
  const itemId = pending?.itemId ?? "";
  const logItem = useThreadStore((s) => (threadId in s.synced ? s.logs[threadId]?.byId[itemId] : undefined));
  const fromLog = useThreadStore(useMemo(() => logContext(threadId, itemId), [threadId, itemId]));
  const detail = useNeedsStore((s) => (pending ? s.details[pending.requestId] : undefined));
  const logRequest = logItem && (logItem.kind === "permission" || logItem.kind === "question") ? logItem.request : null;
  const toRead = read && !logRequest && !detail ? pending : null;
  useEffect(() => {
    if (toRead) readDetail(threadId, toRead);
  }, [toRead, threadId]);
  return { pending, count: open.length, request: logRequest ?? detail?.request ?? null, context: fromLog ?? detail?.context ?? "" };
}
