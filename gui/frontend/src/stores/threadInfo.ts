/**
 * What the thread info card reads besides the stores it selects from directly
 * (docs/notes/thread-info-card.md): the installed editor apps, each member project's action
 * pick for the thread, and the card's own sends. Everything it runs is a registry command
 * (thread.send, worktree.reveal, worktree.open.editor, …) or an existing store action.
 */
import { toast } from "sonner";
import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { getActionPick } from "@/api/actions";
import { listEditorApps, type EditorAppView } from "@/api/gitops";
import { sendErrorMessage } from "@/api/stream";
import { copyText } from "@/lib/clipboard";
import { otherModelWorksIn, type MemberPick } from "@/lib/threadInfo";
import { useActionsStore } from "./actions";
import { runAction } from "./actionActions";
import { invokeConfirmed, refreshCommands } from "./commands";
import { holdFailedNotice } from "./failedNotice";
import { createResource, useResource } from "./resource";
import { THREAD_COMMANDS, threadContext } from "./threadActions";
import { useThreadsStore } from "./threads";

const SEP = "\u0000";
/** Joins resource keys, which may hold SEP themselves (detailKey). */
const KEYS = "\u0002";

/** GitOpsService.ListEditorApps: the daemon caches the list, so one key for the window. */
export const editorAppsResource = createResource<EditorAppView[]>((_key, signal) => listEditorApps(false, undefined, signal));

/** The installed editors, for "Open in" (empty until read). */
export function useEditorApps(): readonly EditorAppView[] {
  return useResource(editorAppsResource, "apps")?.data ?? NO_APPS;
}
const NO_APPS: readonly EditorAppView[] = [];

/**
 * ActionService.LastRun per member project with actions, for one thread. The key names
 * the thread, the projects and the newest run among them, so a run (from here, a palette,
 * the CLI or an agent) reads the picks again; nothing polls.
 */
export const actionPicksResource = createResource<MemberPick[]>(
  async (key, signal) => {
    const [threadId = "", ids = ""] = key.split(SEP);
    const projectIds = ids ? ids.split(",") : [];
    return Promise.all(
      projectIds.map(async (projectId) => ({
        projectId,
        pick: await getActionPick(projectId, threadId, undefined, signal),
      })),
    );
  },
  { abortOnRelease: true },
);

/**
 * The thread's members that have actions, in the set's order, and each one's pick; null
 * while none has an action (the row is then "Add action"). `memberIds` is the set with the
 * cwd's project first.
 */
export function useActionPicks(threadId: string, memberIds: readonly string[]): { withActions: readonly string[]; picks: readonly MemberPick[] | null } {
  const withActions = useActionsStore(useShallow((s) => memberIds.filter((id) => (s.byProject[id]?.length ?? 0) > 0)));
  // The newest run in any of them (and the action lists), so a run or an edit re-reads the picks.
  const version = useActionsStore((s) => {
    let newest = "";
    let at = -1;
    for (const r of Object.values(s.runs)) {
      if (!withActions.includes(r.projectId)) continue;
      const t = r.startedAtMs ?? 0;
      if (t > at) {
        at = t;
        newest = r.id;
      }
    }
    return `${newest}|${withActions.map((id) => (s.byProject[id] ?? []).join(",")).join(";")}`;
  });
  const key = withActions.length > 0 ? [threadId, withActions.join(","), version].join(SEP) : null;
  const picks = useResource(actionPicksResource, key)?.data ?? null;
  return { withActions, picks };
}

/**
 * Whether the thread body on screen has room for the card (lib/threadInfo cardFits), as
 * ThreadPane measures it; the header toggle says "Not enough room" while it has none.
 */
export const useCardRoom = create<{ room: boolean }>()(() => ({ room: true }));

export function setCardRoom(room: boolean): void {
  if (useCardRoom.getState().room !== room) useCardRoom.setState({ room });
}

/** Whether another thread's model is working in the checkout at `path` (lib/threadInfo otherModelWorksIn). */
export function useCheckoutShared(threadId: string, path: string): boolean {
  return useThreadsStore((s) => otherModelWorksIn(s, threadId, path));
}

/**
 * The card's sends and git commands in flight, by `pendingKey`: a second press while one
 * runs does nothing, and its button shows disabled until it settles (the `rerunning` rule
 * of stores/actionActions.ts, kept in a store so the button re-renders).
 */
const usePending = create<{ pending: Readonly<Record<string, true>> }>()(() => ({ pending: {} }));

/** A card row's key in the pending set: one per thread and row. */
export const pendingKey = (threadId: string, row: string): string => `${threadId}${SEP}${row}`;

/** Whether the row's send or command is in flight. */
export function useCardPending(key: string): boolean {
  return usePending((s) => s.pending[key] === true);
}

/** Runs `run` unless the row has one in flight; the row is pending until it settles. */
export async function runOnce(key: string, run: () => Promise<unknown>): Promise<void> {
  await holdOnce(key, async () => {
    await run();
    return false;
  });
}

/**
 * runOnce for an action whose effect shows later: a run that answers true keeps the row
 * pending until releasePending (a stopped shell's row, until the shell leaves the list).
 */
export async function holdOnce(key: string, run: () => Promise<boolean>): Promise<void> {
  if (usePending.getState().pending[key]) return;
  usePending.setState((s) => ({ pending: { ...s.pending, [key]: true } }));
  let held = false;
  try {
    held = await run();
  } finally {
    if (!held) releasePending(key);
  }
}

/** Ends a row's pending state (holdOnce). */
export function releasePending(key: string): void {
  if (!usePending.getState().pending[key]) return;
  usePending.setState((s) => {
    const { [key]: _done, ...rest } = s.pending;
    return { pending: rest };
  });
}

/**
 * Sends `text` to the thread as the user's message (thread.send, the composer's path: a
 * stopped thread starts, a working one picks it up mid-turn), hiding the composer's
 * failed-prompt notice as a composer send does. The draft is left alone; a failure toasts.
 */
export async function sendThreadPrompt(threadId: string, text: string): Promise<boolean> {
  const release = holdFailedNotice(threadId);
  try {
    const res = await invokeConfirmed(THREAD_COMMANDS.send, { id: threadId, text }, threadContext(threadId));
    if (!res) release();
    return res !== null;
  } catch (err) {
    release();
    toast.error("Send failed", { description: sendErrorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}

/**
 * Runs an action from the card, for the thread: an action of any project of its set runs
 * in the thread's checkout of that project (the daemon's action/thread_run.go), in the
 * thread's bottom panel, and counts for the card's last-run pick.
 */
export async function runCardAction(actionId: string, threadId: string): Promise<void> {
  await runAction(actionId, { kind: "thread", threadId });
}

/** Copies a branch name, with the copy toast the pull request's link uses. */
export async function copyBranchName(branch: string): Promise<void> {
  try {
    await copyText(branch);
    toast.success("Branch copied", { description: branch });
  } catch {
    toast.error("Copy failed");
  }
}

/** Watches several resource keys at once (a workspace's checkouts); the caller selects from the resource's store. */
export function useWatchKeys(watch: (key: string) => () => void, keys: readonly string[]): void {
  const joined = keys.join(KEYS);
  useEffect(() => {
    if (!joined) return;
    const releases = joined.split(KEYS).map((k) => watch(k));
    return () => {
      for (const r of releases) r();
    };
  }, [watch, joined]);
}
