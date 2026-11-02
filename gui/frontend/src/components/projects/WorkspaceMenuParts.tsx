import type { WorkspaceMenuPart } from "./menus";
import { workspaceOpenIn } from "./openIn";
import { OpenInSplitItem } from "./OpenInMenuItem";
import type { RowMenuParts } from "./rowMenu";

/** Open in Finder for the workspace's folder in its index row's right-click menu. */
function ContextOpenIn({ entry }: { entry: WorkspaceMenuPart }) {
  return <OpenInSplitItem target={workspaceOpenIn(entry.workspaceId, entry.terminal)} testId={entry.testId} />;
}

/** The same in its page's ⋯ dropdown. */
function DropdownOpenIn({ entry }: { entry: WorkspaceMenuPart }) {
  return <OpenInSplitItem target={workspaceOpenIn(entry.workspaceId, entry.terminal)} testId={entry.testId} menu="dropdown" />;
}

/** The parts of a workspace's menu (menus.ts workspaceMenu) in its index row's right-click menu. */
export const WORKSPACE_MENU_PARTS: RowMenuParts<WorkspaceMenuPart> = { "workspace-open-in": ContextOpenIn };

/** The same in its page's ⋯ dropdown (OverflowMenu). */
export const WORKSPACE_DROPDOWN_PARTS: RowMenuParts<WorkspaceMenuPart> = { "workspace-open-in": DropdownOpenIn };
