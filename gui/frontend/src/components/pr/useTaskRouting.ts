/**
 * The threads a readiness box's task buttons route between (taskRouting), read once per
 * box: every thread that links the pull request, as the few fields routing reads
 * (TaskThread). The selectors return string keys compared with useShallow, so a thread
 * elsewhere changing, or a field routing does not read, re-renders nothing.
 * docs/notes/pr-panel-tasks.md, docs/notes/pr-task-forward.md.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PullRequestDetailView } from "@/api/gh";
import type { ThreadView } from "@/api/threads";
import { inSidebar, type ThreadsById } from "@/lib/inSidebar";
import { EMBER_RESIDENT } from "@/stores/ember";
import { useProjectsStore } from "@/stores/projects";
import { isOwned, useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { isProjectRepo, linksPullRequest, taskRouting, type TaskRouting, type TaskThread } from "./taskRouting";

const SEP = "\u0000";

type Repo = Pick<PullRequestDetailView["pullRequest"], "repoSlug">;

/**
 * Whether a thread is one of the user's own: Ember's, or a thread the sidebar lists (the
 * sidebar's rules: not a plugin's or a resident's (isOwned), and not a child whose creator
 * is alive (inSidebar)).
 */
export function userThread(t: Pick<ThreadView, "createdBy" | "owner" | "resident">, byId: ThreadsById): boolean {
  return t.resident === EMBER_RESIDENT || (!isOwned(t) && inSidebar(t, byId));
}

/** A thread's TaskThread as a key (decodeTaskThreads reads it back). */
export function encodeTaskThread(t: ThreadView, links: boolean, user: boolean): string {
  const activity = t.lastActivityAtMs ?? t.createdAtMs ?? 0;
  const flag = (b: boolean) => (b ? "1" : "");
  return [t.id, flag(t.archivedAtMs !== null), String(activity), flag(links), flag(user), t.name].join(SEP);
}

export function decodeTaskThreads(keys: readonly string[]): TaskThread[] {
  return keys.map((k) => {
    const [id = "", archived = "", activity = "0", links = "", user = "", ...name] = k.split(SEP);
    return { id, archived: archived === "1", activity: Number(activity), links: links === "1", user: user === "1", name: name.join(SEP) };
  });
}

/**
 * The routing for ref's task buttons: the selection, the threads that link ref (matched
 * on the panel's slug or GitHub's current one) and whether the repository is a project
 * (true until projects have loaded: no clone hint on a guess).
 */
export function useTaskRouting(ref: PrRef, pr: Repo): TaskRouting {
  const selection = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : null));
  const isProject = useProjectsStore((s) => !s.loaded || s.order.some((id) => isProjectRepo([s.byId[id]?.githubSlug ?? ""], ref.slug, pr.repoSlug)));
  const keys = useThreadsStore(
    useShallow((s) => {
      const out: string[] = [];
      for (const t of Object.values(s.byId)) {
        if (!linksPullRequest(t.linkedPullRequests, ref, pr.repoSlug)) continue;
        out.push(encodeTaskThread(t, true, userThread(t, s.byId)));
      }
      return out;
    }),
  );
  return useMemo(() => taskRouting({ selection, ref, threads: decodeTaskThreads(keys), isProject }), [selection, ref, keys, isProject]);
}
