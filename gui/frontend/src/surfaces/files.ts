import { createElement } from "react";
import { FileText } from "lucide-react";
import { FileTab } from "@/components/files/FileTab";
import { lastTabOf } from "@/stores/filePanel";
import { usePanelStore } from "@/stores/panel";
import { FILE_KIND, fileOfTab } from "./fileTarget";
import { NO_PROJECT_WATCHES, noProjectNow } from "./noProject";
import type { SurfaceContext, SurfaceSpec } from "./types";

/**
 * File: one file read from disk (components/files/FileTab.tsx), as code, rendered markdown
 * or HTML, or an image. Tabs are opened from elsewhere (stores/filePanel.ts: the Diff
 * tab's Open file, path chips), one per file: params { project, base, path, line? }
 * (surfaces/fileTarget.ts). F (and the list) bring back the panel's last File tab, so the
 * entry is live only while the panel has one; dimmed otherwise, and hidden for a thread
 * without a project until it has one.
 */
export const filesSurface: SurfaceSpec = {
  kind: FILE_KIND,
  title: "File",
  icon: FileText,
  hotkey: "f",
  available: (ctx: SurfaceContext) => (lastTabOf(FILE_KIND, ctx.panelKey) ? "enabled" : noProjectNow(ctx.selection) ? "hidden" : "disabled"),
  watches: [...NO_PROJECT_WATCHES, usePanelStore],
  render: (tab) => {
    const target = fileOfTab(tab);
    return target ? createElement(FileTab, { target }) : null;
  },
  openDefault: (ctx) => lastTabOf(FILE_KIND, ctx.panelKey),
};
