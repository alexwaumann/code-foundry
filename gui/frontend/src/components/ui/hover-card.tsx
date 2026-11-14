import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { useZoomFactor, zoomPx } from "@/lib/zoom"

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({ className, align = "start", sideOffset = 8, collisionPadding = 12, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  // Offsets are viewport px; scale them with the page zoom (lib/zoom.ts).
  const z = useZoomFactor()
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={zoomPx(sideOffset, z)}
        collisionPadding={zoomPx(collisionPadding, z)}
        className={cn(
          "z-50 rounded-lg border bg-popover text-popover-foreground shadow-lg outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
