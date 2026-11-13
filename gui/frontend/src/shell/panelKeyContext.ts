import { createContext, useContext } from "react";

/**
 * The host seam's target a surface's tab body acts for (`thread:<id>` for a tab linked to a
 * thread, shell/surfaces/panel.ts panelKeyOfTab): the File tab's page bridge
 * (components/files/usePageThread.ts), the MCP tab's state, a pull request's links. "" for an
 * unlinked tab.
 */
export const PanelKeyContext = createContext("");

export function usePanelKey(): string {
  return useContext(PanelKeyContext);
}
