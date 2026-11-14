import { SquarePen } from "lucide-react";
import { ComposeTab } from "@/components/shell/ComposeTab";
import { useLayoutStore } from "@/stores/layout";
import type { ShellSurface } from "./types";

/**
 * The composer as a tab (docs/notes/shell-model.md, "The composer"): sending turns it into the
 * thread's tab (stores/selectionBridge.ts). A draft's label names it; the empty one is "New thread".
 */
export const composeSurface: ShellSurface = {
  kind: "compose",
  icon: SquarePen,
  // A draft's tab is named by its label in the space's draft list (the sidebar's row shows it too).
  useTitle: (tab) => {
    const label = useLayoutStore((s) => {
      const id = tab.params.draft;
      if (!id) return "";
      for (const sp of Object.values(s.spaces)) {
        const d = sp.drafts.find((x) => x.id === id);
        if (d) return d.label;
      }
      return "";
    });
    return tab.name || label || tab.title || "New thread";
  },
  render: (tab) => <ComposeTab tab={tab} />,
};
