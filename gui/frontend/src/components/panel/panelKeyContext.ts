import { createContext, useContext } from "react";

/**
 * The panel key (stores/panel.ts keyOf) of the panel a surface's tab body renders in, for
 * a body that acts for its selection (the File tab's page bridge: components/files/
 * usePageThread.ts). "" outside a panel.
 */
export const PanelKeyContext = createContext("");

export function usePanelKey(): string {
  return useContext(PanelKeyContext);
}
