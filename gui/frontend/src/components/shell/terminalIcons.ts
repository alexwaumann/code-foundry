/** The icon of each kind of command a terminal tab names (lib/terminalName.ts). */
import { Activity, Bot, Container, Database, FileCode, GitBranch, Hammer, Package, Play, ScrollText, Server, SquarePen, SquareTerminal, type LucideIcon } from "lucide-react";
import type { TerminalIconKind } from "@/lib/terminalName";

export const TERMINAL_ICONS: Readonly<Record<TerminalIconKind, LucideIcon>> = {
  shell: SquareTerminal,
  git: GitBranch,
  package: Package,
  build: Hammer,
  editor: SquarePen,
  remote: Server,
  container: Container,
  monitor: Activity,
  log: ScrollText,
  database: Database,
  python: FileCode,
  agent: Bot,
  run: Play,
};
