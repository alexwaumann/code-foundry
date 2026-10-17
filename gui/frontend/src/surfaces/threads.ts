import { createElement } from "react";
import { Network } from "lucide-react";
import { ThreadsSurface } from "@/components/lineage/ThreadsSurface";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { selectionThreadsThread, THREADS_KIND, THREADS_TITLE, threadsTab } from "./threadsTarget";
import type { SurfaceSpec } from "./types";

function thread(sel: Selection): string | null {
  return selectionThreadsThread(sel, { repos: useProjectsStore.getState(), threads: useThreadsStore.getState() });
}

/**
 * Threads: the selected thread's lineage, derived from the thread list (no RPC): the
 * thread whose agent created it, the thread itself, its siblings and the threads created
 * from it, each with status, place, age and brief (/tmp/cf-lineage-sketch variant C,
 * docs/notes/agents-3-lineage-gui.md). Enabled for a thread, hidden otherwise. One tab per
 * panel, no params: the body follows the selection's thread, like Agents. Opened by H in
 * the panel, by view.panel.threads and by the header's "from …" chip
 * (stores/threadsPanel.ts).
 */
export const threadsSurface: SurfaceSpec = {
  kind: THREADS_KIND,
  title: THREADS_TITLE,
  icon: Network,
  hotkey: "h",
  available: (ctx) => (thread(ctx.selection) ? "enabled" : "hidden"),
  watches: [useThreadsStore, useProjectsStore],
  render: () => createElement(ThreadsSurface),
  openDefault: (ctx) => (thread(ctx.selection) ? threadsTab() : null),
};
