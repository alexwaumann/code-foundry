import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Folder, FolderGit2 } from "lucide-react";
import { GithubMark } from "@/components/icons/GithubMark";
import { checkoutThreads, projectKind, sortCheckouts, type ProjectKind } from "@/lib/projects";
import { useThreadsStore } from "@/stores/threads";
import { savedScrollTop, saveScrollTop } from "@/stores/projectsPage";
import { useProjectsStore } from "@/stores/projects";

/** The Projects view's kind icons (docs/notes/projects-redesign-1-index.md, the icon table). */
export const KIND_ICON: Record<ProjectKind, { Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  github: { Icon: GithubMark, className: "text-cf-info-text" },
  git: { Icon: FolderGit2, className: "text-cf-text-muted" },
  nogit: { Icon: Folder, className: "text-cf-text-muted" },
};

const UNKNOWN_PROJECT = { githubSlug: "", remotes: [] };

/** A project's kind (subscribes to that string only). */
export function useProjectKind(projectId: string): ProjectKind {
  return useProjectsStore((s) => projectKind(s.byId[projectId] ?? UNKNOWN_PROJECT).kind);
}

/**
 * The page's scroll box: starts at the offset it had when the page (its panel key) was
 * last shown in this window, and remembers it (in memory, stores/projectsPage.ts).
 */
export function usePageScroll(key: string, given?: React.RefObject<HTMLDivElement | null>): React.RefObject<HTMLDivElement | null> {
  const own = useRef<HTMLDivElement>(null);
  const ref = given ?? own;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // After the rows render (the page builds them in this commit).
    const top = savedScrollTop(key);
    if (top > 0) el.scrollTop = top;
    const onScroll = () => {
      saveScrollTop(key, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [key, ref]);
  return ref;
}

/** The checkouts in the table's order (lib/projects.ts sortCheckouts); rebuilds on membership, working counts and activity only. */
export function useCheckoutOrder(projectId: string): string[] {
  const rows = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).map((w) => `${w.path}\u0001${w.isMain ? "1" : ""}\u0001${w.branch}`)));
  const paths = useMemo(() => rows.map((r) => r.split("\u0001")[0] ?? ""), [rows]);
  const activity = useThreadsStore(useShallow((s) => paths.map((p) => {
    const t = checkoutThreads(s, p);
    return `${String(t.working)}\u0001${String(t.lastMs ?? "")}`;
  })));
  return useMemo(() => {
    const decoded = rows.map((r, i) => {
      const [path = "", main = "", branch = ""] = r.split("\u0001");
      const [w = "0", last = ""] = (activity[i] ?? "").split("\u0001");
      return { path, isMain: main === "1", branch, working: Number(w), lastMs: last === "" ? null : Number(last) };
    });
    return sortCheckouts(decoded).map((r) => r.path);
  }, [rows, activity]);
}

