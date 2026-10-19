/** Where a long VirtualStack list virtualizes (components/pr/VirtualStack.tsx). */
import { createContext } from "react";

/**
 * The element a long list virtualizes against, when a box around it scrolls on its own
 * (a plugin's sized pane, a wide master-detail's sides, the surface's scroll area): its
 * provider sets it once mounted (null until then: the list waits). Not provided
 * (undefined), the list finds it in the DOM (scrollParent).
 */
export const VirtualScrollRoot = createContext<HTMLElement | null | undefined>(undefined);
