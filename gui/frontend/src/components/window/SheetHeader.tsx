import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Header of a page shown in a sheet (DialogContent size="sheet"; Settings, Themes, Usage): the
 * pane header's height (44 px, PaneHeader) and divider, without its window dragging or
 * traffic-light gutter, since a sheet sits in the middle of the window.
 */
export function SheetHeader({ className, ...rest }: ComponentProps<"header">) {
  return <header {...rest} data-sheet-header className={cn("flex h-11 shrink-0 items-center border-b border-cf-divider", className)} />;
}
