import { createElement } from "react";
import { FileDiff } from "lucide-react";
import { makeTab } from "@/stores/panel";
import { SurfacePlaceholder } from "./Placeholder";
import type { SurfaceSpec } from "./types";

/** Diff: registered so the panel lists it; not implemented yet, so always disabled. */
export const diffSurface: SurfaceSpec = {
  kind: "diff",
  title: "Diff",
  icon: FileDiff,
  hotkey: "d",
  available: () => "disabled",
  render: () => createElement(SurfacePlaceholder, { icon: FileDiff, title: "Diff" }),
  openDefault: () => makeTab("diff", "Diff"),
};
