import { useCallback } from "react";
import type { FieldValue, ViewAction } from "@/api/plugin";
import { actOnElement, copyElementText, openElementUrl, runCommandElement } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";

/**
 * What clicking an element does (PRIMITIVES.md §A "action"): an event goes to the plugin
 * as an act on the element's key; a command runs with the panel's context through
 * runCommand (the daemon's confirm dialog included); a URL opens in the browser and text
 * is copied, both by the host, never reaching the plugin.
 */
export function useRunAction(): (key: string, action: ViewAction | undefined, values?: Readonly<Record<string, FieldValue>>) => void {
  const { watchKey, uiContext, inert } = useViewCtx();
  return useCallback(
    (key, action, values) => {
      if (!action || inert) return;
      if (action.event) void actOnElement(watchKey, key, values ? { values } : {});
      else if (action.command) void runCommandElement(watchKey, key, action.command.name, { ...action.command.args }, uiContext);
      else if (action.openUrl) openElementUrl(action.openUrl);
      else if (action.copy !== undefined) void copyElementText(action.copy);
    },
    [watchKey, uiContext, inert],
  );
}
