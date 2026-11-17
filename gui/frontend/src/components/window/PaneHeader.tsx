import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { PANE_HEADER_HEIGHT } from "./titleBand";

/**
 * Header of a page in the content pane: PANE_HEADER_HEIGHT (44 px), so below the pane's
 * shell-gap top margin (12 px) it ends on the title band's bottom edge (titleBand.ts),
 * level with a pane's tab strip, and its middle is the band's centre. The top bar spans the
 * window above the panes and the sidebar is never fully hidden (its rail stays), so the
 * pane's corner is never under the traffic lights and the header needs no gutter.
 *
 * It drags the window (Wails runtime, `--wails-draggable: drag`; double-click zooms).
 * The property inherits, so controls in it sit in a `[--wails-draggable:no-drag]`
 * wrapper; buttons, inputs, links, tabs and separators are also no-drag by a base rule
 * in index.css.
 */
export function PaneHeader({ className, style, ...rest }: ComponentProps<"header">) {
  return (
    <header
      {...rest}
      data-pane-header
      className={cn("flex shrink-0 items-center border-b border-cf-divider [--wails-draggable:drag]", className)}
      style={{ height: PANE_HEADER_HEIGHT, ...style }}
    />
  );
}
