import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { useZoomFactor, zoomPx } from "@/lib/zoom"

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({ className, align = "start", sideOffset = 6, alignOffset, collisionPadding, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Offsets are viewport px; scale them with the page zoom (lib/zoom.ts).
  const z = useZoomFactor()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={zoomPx(sideOffset, z)}
        alignOffset={zoomPx(alignOffset, z)}
        collisionPadding={zoomPx(collisionPadding, z)}
        className={cn(
          "z-50 w-60 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverTrigger, PopoverContent }
