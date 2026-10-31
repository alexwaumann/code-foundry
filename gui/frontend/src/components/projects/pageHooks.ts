import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { checkoutRows } from "@/lib/leftovers";
import { checkoutThreads, sortCheckouts } from "@/lib/projects";
import { useThreadsStore } from "@/stores/threads";
import { savedScrollTop, saveScrollTop } from "@/stores/projectsPage";
import { useProjectsStore } from "@/stores/projects";

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

/**
 * The Checkouts table's rows in its order (lib/projects.ts sortCheckouts): main plus the
 * worktrees a thread is on (lib/leftovers.ts checkoutRows; the rest are in "Worktrees
 * without threads"). Rebuilds on membership, working counts and activity only.
 */
export function useCheckoutOrder(projectId: string): string[] {
  const all = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).map((w) => `${w.path}\u0001${w.isMain ? "1" : ""}\u0001${w.branch}`)));
  const rows = useThreadsStore(useShallow((s) => checkoutRows(all.map((r) => {
    const [path = "", main = ""] = r.split("\u0001");
    return { path, isMain: main === "1", r };
  }), s).map((w) => w.r)));
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

