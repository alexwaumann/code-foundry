import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import { PANE_HEADER_HEIGHT, trafficLightGutter } from "./titleBand";

/**
 * Header of a page in the content pane: PANE_HEADER_HEIGHT (44 px), so below the pane's
 * shell-gap top margin (12 px) it ends on the title band's bottom edge (titleBand.ts),
 * level with the sidebar band and the side panel's header, and its middle is the band's
 * centre, where the traffic lights and the app name sit. With the sidebar hidden the
 * pane's top-left corner sits under the traffic lights, so the header's content starts
 * past the gutter.
 *
 * It drags the window (Wails runtime, `--wails-draggable: drag`; double-click zooms).
 * The property inherits, so controls in it sit in a `[--wails-draggable:no-drag]`
 * wrapper; buttons, inputs, links, tabs and separators are also no-drag by a base rule
 * in index.css.
 */
export function PaneHeader({ className, style, ...rest }: ComponentProps<"header">) {
  const sidebarHidden = useUiStore((s) => !s.sidebarVisible);
  const gutter = useUiStore((s) => trafficLightGutter(s.zoom));
  return (
    <header
      {...rest}
      data-pane-header
      className={cn("flex shrink-0 items-center border-b border-pane-border [--wails-draggable:drag]", className)}
      style={{ height: PANE_HEADER_HEIGHT, ...style, ...(sidebarHidden ? { paddingLeft: gutter } : null) }}
    />
  );
}
