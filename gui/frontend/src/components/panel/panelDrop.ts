/** The side panel's drag state (PanelDnd provides it), for the strips' slot marker, the body tint and the drop band. */
import { createContext, useContext } from "react";
import type { GroupIndex, Tab } from "@/stores/panel";
import type { DropTarget } from "./dragDrop";
import type { SplitOrientation } from "./splitLayout";

/** The tab being dragged and the group it came from. */
export interface PanelDrag {
  tab: Tab;
  group: GroupIndex;
}

/**
 * What the panel's strips and bodies draw while a tab is dragged: the drag, where a drop
 * would put it now, and which edge the drop band takes on an unsplit panel.
 */
export interface PanelDropState {
  drag: PanelDrag | null;
  target: DropTarget | null;
  band: SplitOrientation;
}

export const PanelDropContext = createContext<PanelDropState>({ drag: null, target: null, band: "stack" });

/** The panel's drag state (PanelDnd). */
export function usePanelDrop(): PanelDropState {
  return useContext(PanelDropContext);
}
