import { SquareTerminal } from "lucide-react";
import { TerminalTabBody, TerminalTabIcon, TerminalTabMenu } from "@/components/shell/TerminalTab";
import { useTerminalTabName } from "@/shell/terminalTab";
import type { ShellSurface } from "./types";

/**
 * A terminal tab (docs/notes/shell-model.md, "Terminals"): a shell or an action run, linked to a
 * thread or to nothing, named by what runs in it with an icon per kind of command, idle by its
 * shell and folder; a manual name sticks until the automatic one is asked for again (its context
 * menu, cmd+r, cmd+shift+r). Its body is the xterm, attached only while the tab is active.
 * Closing the tab by itself ends the terminal (the daemon's glue, docs/notes/shell-6-lifecycle.md).
 */
export const terminalSurface: ShellSurface = {
  kind: "terminal",
  icon: SquareTerminal,
  TabIcon: TerminalTabIcon,
  useTitle: (tab) => useTerminalTabName(tab).name,
  render: (tab) => <TerminalTabBody tab={tab} />,
  tabMenu: (tab) => <TerminalTabMenu tab={tab} />,
};
