import { createContext } from "react";

/**
 * Whether thread rows may open their hover tooltip. SidebarList provides false while the
 * list's context menu is open, so hovering other rows does not cover the menu.
 */
export const RowTooltipsEnabled = createContext(true);
