import { SquarePen } from "lucide-react";
import { ComposeTab } from "@/components/shell/ComposeTab";
import type { ShellSurface } from "./types";

/**
 * The composer as a tab (docs/notes/shell-model.md, "The composer"): sending turns it into the
 * thread's tab (stores/selectionBridge.ts). A draft's label names it; the empty one is "New thread".
 */
export const composeSurface: ShellSurface = {
  kind: "compose",
  icon: SquarePen,
  useTitle: (tab) => tab.name || tab.title || "New thread",
  render: (tab) => <ComposeTab tab={tab} />,
};
