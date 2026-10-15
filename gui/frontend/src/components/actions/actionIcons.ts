import { Bug, FlaskConical, Hammer, ListChecks, Play, Wrench, type LucideIcon } from "lucide-react";
import type { ActionIconName } from "@/api/actions";

/** The six action icons (the sketch's lucide picks) and the editor's tile labels. */
export const ACTION_ICON: Readonly<Record<ActionIconName, LucideIcon>> = {
  play: Play,
  test: FlaskConical,
  lint: ListChecks,
  configure: Wrench,
  build: Hammer,
  debug: Bug,
};

export const ACTION_ICON_LABEL: Readonly<Record<ActionIconName, string>> = {
  play: "Play",
  test: "Test",
  lint: "Lint",
  configure: "Configure",
  build: "Build",
  debug: "Debug",
};
