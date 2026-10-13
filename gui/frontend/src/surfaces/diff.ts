import { createElement } from "react";
import { FileDiff } from "lucide-react";
import { makeTab } from "@/stores/panel";
import { NO_PROJECT_WATCHES, noProjectNow } from "./noProject";
import { SurfacePlaceholder } from "./Placeholder";
import type { SurfaceSpec } from "./types";

/** Diff: registered so the panel lists it; not implemented yet, so always disabled. */
export const diffSurface: SurfaceSpec = {
  kind: "diff",
  title: "Diff",
  icon: FileDiff,
  hotkey: "d",
  // Hidden for a thread (or composer) without a project: there are no files or diff to show.
  available: (ctx) => (noProjectNow(ctx.selection) ? "hidden" : "disabled"),
  watches: NO_PROJECT_WATCHES,
  render: () => createElement(SurfacePlaceholder, { icon: FileDiff, title: "Diff" }),
  openDefault: () => makeTab("diff", "Diff"),
};
