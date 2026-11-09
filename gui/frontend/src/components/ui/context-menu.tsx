import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { itemLeaveWhileClosing } from "@/components/ui/menuItemLeave"
import { useZoomFactor, zoomPx } from "@/lib/zoom"

const contentClass =
  "z-50 max-h-[calc(var(--radix-context-menu-content-available-height)/var(--cf-zoom))] min-w-[10rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"

const itemClass =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-label outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-cf-error-text data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({ className, alignOffset, collisionPadding, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  // Offsets are viewport px; scale them with the page zoom (lib/zoom.ts).
  const z = useZoomFactor()
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content data-slot="context-menu-content" className={cn(contentClass, className)} alignOffset={zoomPx(alignOffset, z)} collisionPadding={zoomPx(collisionPadding, z)} {...props} />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, variant = "default", onPointerLeave, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { variant?: "default" | "destructive" }) {
  return <ContextMenuPrimitive.Item data-slot="context-menu-item" data-variant={variant} className={cn(itemClass, className)} onPointerLeave={itemLeaveWhileClosing(onPointerLeave)} {...props} />
}

function ContextMenuRadioGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

/** A one-pick item: a check at the left marks the picked one (its group's value). */
function ContextMenuRadioItem({ className, children, onPointerLeave, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem data-slot="context-menu-radio-item" className={cn(itemClass, "pl-7.5", className)} onPointerLeave={itemLeaveWhileClosing(onPointerLeave)} {...props}>
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

/** `chevron={false}` leaves the trailing chevron to the caller (a split item draws it in its own block). */
function ContextMenuSubTrigger({ className, children, chevron = true, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { chevron?: boolean }) {
  return (
    <ContextMenuPrimitive.SubTrigger data-slot="context-menu-sub-trigger" className={cn(itemClass, "data-[state=open]:bg-accent", className)} {...props}>
      {children}
      {chevron && <ChevronRightIcon className="ml-auto size-4" />}
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({ className, sideOffset, alignOffset, collisionPadding, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const z = useZoomFactor()
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        data-slot="context-menu-sub-content"
        className={cn(contentClass, className)}
        sideOffset={zoomPx(sideOffset, z)}
        alignOffset={zoomPx(alignOffset, z)}
        collisionPadding={zoomPx(collisionPadding, z)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label data-slot="context-menu-label" className={cn("px-2 py-1.5 text-caption-sm font-medium", className)} {...props} />
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuLabel,
  ContextMenuSeparator,
}
