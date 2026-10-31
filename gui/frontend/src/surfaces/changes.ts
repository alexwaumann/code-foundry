import { createElement } from "react";
import { FileDiff } from "lucide-react";
import { ChangesView } from "@/components/changes/ChangesView";
import { CHANGES_KIND, CHANGES_TITLE, changesOfTab } from "./changesTarget";
import type { SurfaceSpec } from "./types";

/**
 * Changes: one worktree's changed files against its base and its commits ahead
 * (components/changes/ChangesView.tsx). Opened only from elsewhere, so it has no hotkey
 * and is never listed: the thread info card's Changes row and its per-project rows
 * (stores/changesPanel.ts openChangesTab), and the Projects page's project and worktree
 * rows (into the page's panel). Tab: params { project, path }, one per worktree.
 */
export const changesSurface: SurfaceSpec = {
  kind: CHANGES_KIND,
  title: CHANGES_TITLE,
  icon: FileDiff,
  available: () => "hidden",
  render: (tab) => {
    const t = changesOfTab(tab);
    return t ? createElement(ChangesView, { projectId: t.projectId, path: t.path }) : null;
  },
  openDefault: () => null,
};
