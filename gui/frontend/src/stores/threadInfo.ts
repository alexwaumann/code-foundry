/**
 * What the thread info card reads besides the stores it selects from directly
 * (docs/notes/thread-info-card.md): the installed editor apps, each member project's action
 * pick for the thread, and the card's own sends. Everything it runs is a registry command
 * (thread.send, worktree.reveal, worktree.open.editor, …) or an existing store action.
 */
import { toast } from "sonner";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { getActionPick } from "@/api/actions";
import { listEditorApps, type EditorAppView } from "@/api/gitops";
import { sendErrorMessage } from "@/api/stream";
import { copyText } from "@/lib/clipboard";
import type { MemberPick } from "@/lib/threadInfo";
import { isRunningThread } from "@/lib/thread";
import { useActionsStore } from "./actions";
import { invokeConfirmed, refreshCommands } from "./commands";
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
 * Whether another live thread (not archived or snoozed, its Claude running) works in the
 * checkout at `path`: its cwd, or a checkout it records there.
 */
export function useCheckoutShared(threadId: string, path: string): boolean {
  return useThreadsStore((s) => {
    if (!path) return false;
    const now = Date.now();
    return s.order.some((id) => {
      if (id === threadId) return false;
      const t = s.byId[id];
      if (!t || !isRunningThread(t, now)) return false;
      return t.worktreePath === path || t.checkoutPaths.some((c) => c.path === path);
    });
  });
}

/**
 * Sends `text` to the thread as the user's message (thread.send, the composer's path: a
 * stopped thread starts, a working one picks it up mid-turn). The draft is left alone; a
 * failure toasts.
 */
export async function sendThreadPrompt(threadId: string, text: string): Promise<boolean> {
  try {
    const res = await invokeConfirmed(THREAD_COMMANDS.send, { id: threadId, text }, threadContext(threadId));
    return res !== null;
  } catch (err) {
    toast.error("Send failed", { description: sendErrorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
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
