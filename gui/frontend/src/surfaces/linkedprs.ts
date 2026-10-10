import { createElement } from "react";
import { GitPullRequestArrow } from "lucide-react";
import { LinkedPRsSurface } from "@/components/linkedprs/LinkedPRsSurface";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";
import { LINKED_PRS_KIND, LINKED_PRS_TITLE, linkedPrsTab, selectionLinkedThread } from "./linkedprsTarget";
import type { SurfaceSpec } from "./types";

function thread(sel: Selection): string | null {
  return selectionLinkedThread(sel, { repos: useReposStore.getState(), sessions: useSessionsStore.getState(), terminals: useTerminalsStore.getState() });
}

/**
 * Linked PRs: the pull requests Claude linked to the selected thread (its pr-link
 * transcript records), newest first, with state, checks and branch; a row opens the pull
 * request as its own tab. Enabled for a thread (or a thread's terminal) with at least one
 * link, hidden otherwise. One tab per panel, no params: the body follows the selection's
 * thread, like the workspace surface. Opened by L in the panel, view.panel.linked-prs
 * (the thread header's button) and the sidebar's PR badge (stores/linkedPrsPanel.ts).
 */
export const linkedPrsSurface: SurfaceSpec = {
  kind: LINKED_PRS_KIND,
  title: LINKED_PRS_TITLE,
  icon: GitPullRequestArrow,
  hotkey: "l",
  available: (ctx) => (thread(ctx.selection) ? "enabled" : "hidden"),
  // deriveContext reads the repos store too (placement); the links come from sessions.
  watches: [useSessionsStore, useTerminalsStore, useReposStore],
  render: () => createElement(LinkedPRsSurface),
  openDefault: (ctx) => (thread(ctx.selection) ? linkedPrsTab() : null),
};
