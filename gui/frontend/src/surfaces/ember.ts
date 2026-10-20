import { createElement } from "react";
import { SquareKanban } from "lucide-react";
import { BoardSurface } from "@/components/ember/BoardSurface";
import { EMBER_ENABLED } from "@/stores/ember";
import { useSettingsStore } from "@/stores/settings";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { emberBoardTab, EMBER_KIND, EMBER_TITLE, selectionIsEmber } from "./emberTarget";
import type { SurfaceSpec } from "./types";

function shown(sel: Selection): boolean {
  return selectionIsEmber(sel, useThreadsStore.getState(), useSettingsStore.getState().snapshot?.values[EMBER_ENABLED] === "true");
}

/**
 * Board: Ember's task board (docs/notes/ember-3-gui.md), in the panel of Ember's chat
 * only, and only while Ember is on (hidden everywhere else, so no other panel lists it).
 * One tab per panel, no params. Opened by B in the panel, the chat header's Board button,
 * a task link in Ember's text (scrolled to the task) and the pinned row's menu
 * (stores/emberPanel.ts).
 */
export const emberSurface: SurfaceSpec = {
  kind: EMBER_KIND,
  title: EMBER_TITLE,
  icon: SquareKanban,
  hotkey: "b",
  available: (ctx) => (shown(ctx.selection) ? "enabled" : "hidden"),
  watches: [useThreadsStore, useSettingsStore],
  render: () => createElement(BoardSurface),
  openDefault: (ctx) => (shown(ctx.selection) ? emberBoardTab() : null),
};
