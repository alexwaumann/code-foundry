import { createElement } from "react";
import { FileText } from "lucide-react";
import { makeTab } from "@/stores/panel";
import { SurfacePlaceholder } from "./Placeholder";
import type { SurfaceSpec } from "./types";

/** Files: registered so the panel lists it; not implemented yet, so always disabled. */
export const filesSurface: SurfaceSpec = {
  kind: "files",
  title: "Files",
  icon: FileText,
  hotkey: "f",
  available: () => "disabled",
  render: () => createElement(SurfacePlaceholder, { icon: FileText, title: "Files" }),
  openDefault: () => makeTab("files", "Files"),
};
