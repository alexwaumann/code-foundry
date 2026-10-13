import { createElement } from "react";
import { FileText } from "lucide-react";
import { makeTab } from "@/stores/panel";
import { NO_PROJECT_WATCHES, noProjectNow } from "./noProject";
import { SurfacePlaceholder } from "./Placeholder";
import type { SurfaceSpec } from "./types";

/** Files: registered so the panel lists it; not implemented yet, so always disabled. */
export const filesSurface: SurfaceSpec = {
  kind: "files",
  title: "Files",
  icon: FileText,
  hotkey: "f",
  // Hidden for a thread (or composer) without a project: there are no files or diff to show.
  available: (ctx) => (noProjectNow(ctx.selection) ? "hidden" : "disabled"),
  watches: NO_PROJECT_WATCHES,
  render: () => createElement(SurfacePlaceholder, { icon: FileText, title: "Files" }),
  openDefault: () => makeTab("files", "Files"),
};
