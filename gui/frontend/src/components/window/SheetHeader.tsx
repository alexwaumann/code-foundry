import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { PANE_HEADER_HEIGHT } from "./titleBand";

/**
 * Header of a page shown in a sheet (DialogContent size="sheet"; Settings, Themes, Usage): the
 * pane header's height (PANE_HEADER_HEIGHT, as PaneHeader) and divider, without its window
 * dragging or traffic-light gutter, since a sheet sits in the middle of the window.
 */
export function SheetHeader({ className, style, ...rest }: ComponentProps<"header">) {
  return <header {...rest} data-sheet-header style={{ height: PANE_HEADER_HEIGHT, ...style }} className={cn("flex shrink-0 items-center border-b border-cf-divider", className)} />;
}
