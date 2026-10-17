import { createElement } from "react";
import { ChartColumn } from "lucide-react";
import { UsageSurface } from "@/components/usage/UsageSurface";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import type { SurfaceSpec } from "./types";
import { selectionUsageThread, USAGE_KIND, USAGE_TITLE, usageTab } from "./usageTarget";

function thread(sel: Selection): string | null {
  return selectionUsageThread(sel, { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() });
}

/**
 * Usage: the selected thread's token usage and its cost at Claude API rates, per model and
 * per token kind (docs/sketches/session-usage/DESIGN.md, the thread surface). Enabled for
 * a thread, even one without usage yet; hidden otherwise. One tab
 * per panel, no params: the body follows the selection's thread, like Linked PRs. Opened
 * by U in the panel and by view.panel.usage (stores/usagePanel.ts).
 */
export const usageSurface: SurfaceSpec = {
  kind: USAGE_KIND,
  title: USAGE_TITLE,
  icon: ChartColumn,
  hotkey: "u",
  available: (ctx) => (thread(ctx.selection) ? "enabled" : "hidden"),
  // deriveContext reads the projects store too (placement); the thread comes from threads.
  watches: [useThreadsStore, useProjectsStore],
  render: () => createElement(UsageSurface),
  openDefault: (ctx) => (thread(ctx.selection) ? usageTab() : null),
};
