import * as React from "react"
import { Command as CommandPrimitive, useCommandState } from "cmdk"
import { SearchIcon } from "lucide-react"
import { pointerMoved } from "@/lib/pointerMotion"
import { cn } from "@/lib/utils"

function Command({ className, onPointerMoveCapture, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      // cmdk selects the row under any pointermove. Only a real one reaches the rows, or
      // typing with the mouse at rest selects whatever the new layout put under it.
      onPointerMoveCapture={(e) => {
        if (!pointerMoved()) e.stopPropagation()
        onPointerMoveCapture?.(e)
      }}
      {...props}
    />
  )
}

function CommandInput({
  className,
  leading,
  trailing,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & { leading?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div data-slot="command-input-wrapper" className="flex h-11 items-center gap-2 border-b px-3">
      {leading ?? <SearchIcon className="size-4 shrink-0 opacity-50" />}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-body outline-hidden placeholder:text-cf-placeholder disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {trailing}
    </div>
  )
}

function scrollToTop(list: HTMLElement) {
  list.scrollTop = 0
  for (const inner of list.querySelectorAll("[data-command-scroll]")) inner.scrollTop = 0
}

/**
 * A new search starts at the top of the list. cmdk selects the first row, but scrolls in
 * the same pass, before that selection has rendered: to the old row, wherever the new list
 * put it. So this is a passive effect, after cmdk's layout effect (still before the paint:
 * cmdk's store updates synchronously). A picker that scrolls an element inside the list
 * marks it with data-command-scroll.
 */
function CommandList({ className, ref, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => listRef.current as HTMLDivElement)
  const search: string = useCommandState((s) => s.search)
  const shown = React.useRef(search)
  React.useEffect(() => {
    if (shown.current === search) return
    shown.current = search
    if (listRef.current) scrollToTop(listRef.current)
  }, [search])
  return (
    <CommandPrimitive.List
      ref={listRef}
      data-slot="command-list"
      className={cn("max-h-[min(420px,60vh/var(--cf-zoom))] scroll-py-1 overflow-x-hidden overflow-y-auto", className)}
      {...props}
    />
  )
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-body text-muted-foreground"
      {...props}
    />
  )
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-overline",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-label outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto text-caption-sm tracking-widest", className)}
      {...props}
    />
  )
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator }
