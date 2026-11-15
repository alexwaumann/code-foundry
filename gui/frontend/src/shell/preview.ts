/**
 * Preview tabs in the window (docs/notes/shell-model.md, "Preview tabs"): the daemon decides
 * what a preview is, replaces it and keeps it on a move, a send or a surface opened; the window
 * only sends `tab.keep` for what the user does to it here: typing in its thread's composer, a
 * double click on its tab, "Keep open" in the thread's menu. Reading (focus, scroll, find,
 * selecting text, the info toggle) keeps nothing. See docs/notes/preview-tabs-3-gui.md.
 */
import { useEffect, useRef } from "react";
import { threadDraftKey } from "@/lib/threadDraft";
import { useDraft } from "@/stores/compose";
import { useLayoutStore, type LayoutState } from "@/stores/layout";
import { runLayoutCommand } from "./commands";

/** The id of thread's tab when that tab is a preview, else "" (a thread has one tab in the layout). */
export function previewTabOf(s: Pick<LayoutState, "tabs">, threadId: string): string {
  if (!threadId) return "";
  for (const t of Object.values(s.tabs)) if (t.preview && t.kind === "thread" && t.thread === threadId) return t.id;
  return "";
}

/** previewTabOf as a hook: a string, so a change elsewhere in the layout does not render. */
export function usePreviewTabOf(threadId: string): string {
  return useLayoutStore((s) => previewTabOf(s, threadId));
}

/** Keeps a tab through tab.keep when it is a preview now; anything else is left alone (no call). */
export async function keepPreviewTab(tabId: string): Promise<void> {
  if (!useLayoutStore.getState().tabs[tabId]?.preview) return;
  await runLayoutCommand("tab.keep", { tab: tabId });
}

/**
 * Keeps the thread's preview tab once its composer's draft changes to hold something: text
 * typed, pasted or dictated, or an attachment added. A draft already there when the composer
 * mounts (or when the preview opens) keeps nothing until it changes; each preview tab is asked
 * once, not on every key.
 */
export function useKeepPreviewOnDraft(threadId: string): void {
  const key = threadDraftKey(threadId);
  const text = useDraft(key, "text");
  const attachments = useDraft(key, "attachments").length;
  const tab = usePreviewTabOf(threadId);
  const last = useRef({ text, attachments });
  const asked = useRef("");
  useEffect(() => {
    const prev = last.current;
    last.current = { text, attachments };
    if (prev.text === text && prev.attachments === attachments) return;
    if (!tab || asked.current === tab) return;
    if (text.trim() === "" && attachments === 0) return;
    asked.current = tab;
    void keepPreviewTab(tab);
  }, [tab, text, attachments]);
}
