import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PullRequestView } from "@/api/gh";
import type { CompletionGroup } from "@/lib/completion";
import { prCandidates, prEnterPicks, prItems, prPool, threadCandidates, threadItems, type ThreadRow } from "@/lib/tagCandidates";
import { statusLine, statusText } from "@/lib/statusLine";
import { NO_PROJECT } from "@/lib/threadRow";
import { branchPullRequestsResource, DASHBOARD_KEY, dashboardResource } from "@/stores/gh";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { EditorTrigger } from "./PromptEditor";
import type { CompletionSource } from "./useCompletion";

/**
 * The completion sources for thread and pull request tags (docs/notes/composer-thread-pr-tags.md):
 * `@` offers other threads above the files, `#` the pull requests the daemon polls.
 * Hooks only; matching and rows are lib/tagCandidates.ts.
 */

const SEP = "\u0001";
const NONE: readonly string[] = [];
const NO_PRS: readonly PullRequestView[] = [];

/** What a thread is doing, in the sidebar's words, without a time: "Working", "Needs input · Bash", "Idle". */
function statusWords(t: Parameters<typeof statusLine>[0]): string {
  const l = statusLine(t);
  return l.kind === "place" ? "Idle" : statusText({ ...l, at: null }, 0);
}

/** The thread rows for a `@` query (null: none): name, then "project · status". */
function useThreadRows(query: string | null, currentId: string): ThreadRow[] {
  // Primitive strings, so a thread that changes in a way the rows do not show re-renders nothing.
  const keys = useThreadsStore(
    useShallow((s) =>
      query === null ? NONE : threadCandidates(Object.values(s.byId), query, currentId).map((t) => [t.id, t.name, t.projectId, statusWords(t)].join(SEP)),
    ),
  );
  const projects = useProjectsStore(
    useShallow((s) =>
      keys.map((k) => {
        const projectId = k.split(SEP)[2] ?? "";
        return projectId ? (s.byId[projectId]?.name ?? projectId) : NO_PROJECT;
      }),
    ),
  );
  return useMemo(
    () =>
      keys.map((k, i) => {
        const [id = "", name = "", , status = ""] = k.split(SEP);
        return { id, name, detail: `${projects[i] ?? ""} · ${status}` };
      }),
    [keys, projects],
  );
}

/**
 * `@`: other threads (lib/tagCandidates threadCandidates: active, not this one, at most
 * three) in a "Threads" group above the files. The rows answer the query the files
 * answer, so both groups move together while the file search catches up; without files
 * (a composer without a project, or a daemon without SearchFiles) the trigger's own.
 * Once threads are listed the files get a "Files" heading (a draft with several projects
 * keeps its project headings).
 */
export function useMentionSource(trigger: EditorTrigger | null, files: CompletionSource | null, currentThreadId: string): CompletionSource {
  const live = trigger?.char === "@" ? trigger.query : null;
  const withFiles = files !== null && files.available;
  const query = withFiles ? files.query : live;
  const rows = useThreadRows(query, currentThreadId);
  // Only while "@" is live: otherwise every thread update would rank the whole list again.
  const anyThread = useThreadsStore((s) => live !== null && threadCandidates(Object.values(s.byId), "", currentThreadId, 1).length > 0);
  const fileGroups = withFiles ? files.groups : null;
  const groups = useMemo<CompletionGroup[]>(() => {
    if (query === null) return [];
    const fg = fileGroups ?? [];
    if (rows.length === 0) return fg;
    const threads: CompletionGroup = { key: "\u0001threads", heading: { kind: "label", text: "Threads" }, items: threadItems(rows) };
    return [threads, ...fg.map((g) => (g.heading ? g : { ...g, heading: { kind: "label" as const, text: "Files" } }))];
  }, [query, rows, fileGroups]);
  const label = rows.length === 0 ? "Files" : withFiles ? "Threads and files" : "Threads";
  return {
    char: "@",
    label,
    available: withFiles || anyThread,
    groups,
    query,
    searching: withFiles && files.searching,
    emptyText: !withFiles ? "No threads match" : anyThread ? "No threads or files match" : files.emptyText,
  };
}

/** The draft's GitHub repositories ("owner/repo", lower case), from its projects. */
export function useProjectSlugs(projectIds: readonly string[]): readonly string[] {
  return useProjectsStore(
    useShallow((s) => [...new Set(projectIds.map((id) => s.byId[id]?.githubSlug.toLowerCase() ?? "").filter((slug) => slug !== ""))]),
  );
}

/**
 * The pull requests the GUI knows in some repositories: the viewer's dashboards
 * (authored, review requested, reviewed, merged lately; GhService.GetDashboard, watched
 * while `watch`) and any branch's list already read for a thread or worktree on screen.
 * Nothing new is polled.
 */
export function usePrPool(slugs: readonly string[], watch: boolean): readonly PullRequestView[] {
  const on = watch && slugs.length > 0;
  useEffect(() => (on ? dashboardResource.watch(DASHBOARD_KEY) : undefined), [on]);
  const dashboard = dashboardResource.store((s) => s.entries[DASHBOARD_KEY]?.data ?? null);
  const branches = branchPullRequestsResource.store(
    useShallow((s) =>
      Object.entries(s.entries).flatMap(([key, e]) => {
        const slug = key.slice(0, key.indexOf("\u0000")).toLowerCase();
        return slugs.includes(slug) && e.data ? [e.data.pullRequests] : [];
      }),
    ),
  );
  return useMemo(() => {
    if (slugs.length === 0) return NO_PRS;
    const lists = dashboard ? [dashboard.authored, dashboard.reviewRequested, dashboard.reviewed, dashboard.recentlyMerged] : [];
    return prPool([...branches, ...lists], slugs);
  }, [dashboard, branches, slugs]);
}

/**
 * `#`: the draft's repositories' pull requests the daemon polls (usePrPool), matched by
 * number or title, at most five. A query nothing matches shows no card at all (quiet), so
 * "#1 priority" or an issue number stays text and Enter still sends; only a pick makes
 * a tag, and Enter picks only on intent (arrow keys, or the exact number: prEnterPicks), so
 * "fixes #18" + Enter sends as typed while #187 is listed. No card until the pool has loaded.
 */
export function usePrSource(trigger: EditorTrigger | null, slugs: readonly string[]): CompletionSource {
  const query = trigger?.char === "#" ? trigger.query : null;
  const pool = usePrPool(slugs, query !== null);
  const groups = useMemo<CompletionGroup[]>(() => {
    if (query === null) return [];
    const items = prItems(prCandidates(pool, query), query, slugs.length > 1);
    return items.length > 0 ? [{ key: "prs", heading: null, items }] : [];
  }, [pool, query, slugs]);
  return { char: "#", label: "Pull requests", available: pool.length > 0, groups, query, searching: false, emptyText: "", quietEmpty: true, enterPicks: prEnterPicks };
}
