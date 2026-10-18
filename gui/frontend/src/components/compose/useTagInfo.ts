import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { prStateLook } from "@/components/prs/prState";
import { useNow } from "@/lib/clock";
import { threadLabel } from "@/lib/prompt";
import { statusLine, statusText } from "@/lib/statusLine";
import { NO_PROJECT } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { usePrPool } from "./useRefSources";
import { PR_ACCENT } from "./tagStyle";

/** What a thread tag shows (the composer's and the sent bubble's): its current name, project and status. */
export interface ThreadTagInfo {
  /** The thread's current name; the tag's label when the thread is not known (removed). */
  name: string;
  known: boolean;
  /** The project's name, "No project", or "" when the thread is not known. */
  project: string;
  /** "Working", "Finished 5 min ago", "Needs input · Bash", "Idle", "Archived", "Snoozed"; "" when not known. */
  status: string;
}

export function useThreadTagInfo(id: string, label: string): ThreadTagInfo {
  const t = useThreadsStore(
    useShallow((s) => {
      const x = s.byId[id];
      return x
        ? { name: x.name, projectId: x.projectId, archived: x.archivedAtMs !== null, snoozed: x.snoozedUntilMs !== null, ...statusLine(x) }
        : null;
    }),
  );
  const project = useProjectsStore((s) => (t === null ? "" : t.projectId ? (s.byId[t.projectId]?.name ?? t.projectId) : NO_PROJECT));
  const now = useNow(30_000);
  if (t === null) return { name: threadLabel(label, id), known: false, project: "", status: "" };
  const status = t.archived ? "Archived" : t.snoozed ? "Snoozed" : t.kind === "place" ? "Idle" : statusText(t, now);
  return { name: threadLabel(t.name, id), known: true, project, status };
}

/** What a pull request tag shows: its title and its state's accent (the PR rows' colour). */
export interface PrTagInfo {
  /** "" when the pull request is not among those the GUI knows. */
  title: string;
  /** The `--chip-accent` class for its state (unknown: muted). */
  accent: string;
  /** "open", "draft", "merged", "closed", "unknown". */
  state: string;
}

export function usePrTagInfo(slug: string, number: number): PrTagInfo {
  const slugs = useMemo(() => [slug.toLowerCase()], [slug]);
  const pool = usePrPool(slugs, true);
  const pr = pool.find((p) => p.number === number);
  const look = prStateLook(pr?.state ?? null, pr?.draft ?? false);
  return { title: pr?.title ?? "", accent: PR_ACCENT[look.tone], state: look.label };
}
