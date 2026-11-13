import { createElement } from "react";
import { FileText } from "lucide-react";
import { FileTab } from "@/components/files/FileTab";
import { fileEditKey, useFileDirty } from "@/stores/fileEdit";
import { confirmCloseFile } from "@/stores/fileRequest";
import { lastTabOf } from "@/stores/filePanel";
import { tabChanges } from "@/shell/host";
import { FILE_KIND, fileOfTab, fileTab } from "./fileTarget";
import { NO_PROJECT_WATCHES, noProjectNow } from "./noProject";
import type { Tab } from "@/shell/host";
import type { SurfaceContext, SurfaceSpec } from "./types";

/**
 * File: one file read from disk (components/files/FileTab.tsx), as code, rendered markdown
 * or HTML, or an image. Tabs are opened from elsewhere (stores/filePanel.ts: the Diff
 * tab's Open file, path chips), one per file: params { project, base, path, line? }
 * (surfaces/fileTarget.ts). F (and the list) bring back the panel's last File tab, so the
 * entry is live only while the panel has one; dimmed otherwise, and hidden for a thread
 * without a project until it has one. A tab editing its file marks unsaved edits in its
 * strip and asks before it closes (stores/fileEdit.ts).
 */
/**
 * The id FileTab keys its edit session by (fileTab(target).id: the file's path), whatever id the
 * host gave the tab: a File tab's is its path (shell/kinds.ts seamTab).
 */
function editTab(tab: Tab): Tab {
  const target = fileOfTab(tab);
  return target ? { ...tab, id: fileTab(target).id } : tab;
}

export const filesSurface: SurfaceSpec = {
  kind: FILE_KIND,
  title: "File",
  icon: FileText,
  hotkey: "f",
  available: (ctx: SurfaceContext) => (lastTabOf(FILE_KIND, ctx.panelKey) ? "enabled" : noProjectNow(ctx.selection) ? "hidden" : "disabled"),
  watches: [...NO_PROJECT_WATCHES, tabChanges],
  beforeClose: (panelKey, tab) => confirmCloseFile(panelKey, editTab(tab)),
  useUnsaved: (panelKey, tab) => useFileDirty(fileEditKey(panelKey, editTab(tab).id)),
  waiting: (tab) => (fileOfTab(tab)?.ask ? "A thread asked you to edit this file" : null),
  render: (tab) => {
    const target = fileOfTab(tab);
    return target ? createElement(FileTab, { target }) : null;
  },
  openDefault: (ctx) => lastTabOf(FILE_KIND, ctx.panelKey),
};
