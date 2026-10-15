import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { cn } from "cn"
import { useZoomFactor, zoomPx } from "@/lib/zoom"

/**
 * shadcn-style wrapper of Radix Tooltip. Unlike upstream shadcn, Tooltip does not wrap its
 * own provider: the app root (App.tsx) has the one TooltipProvider, so its delay (and the
 * skip delay when moving from one trigger to the next) apply across the whole window.
 * Unit tests get one from src/test/setup.ts.
 */
function TooltipProvider({ delayDuration = 500, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({ className, sideOffset = 6, alignOffset, collisionPadding, children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  // Offsets are viewport px; scale them with the page zoom (lib/zoom.ts).
  const z = useZoomFactor()
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={zoomPx(sideOffset, z)}
        alignOffset={zoomPx(alignOffset, z)}
        collisionPadding={zoomPx(collisionPadding, z)}
        className={cn(
          "z-50 rounded-lg border bg-popover text-popover-foreground shadow-lg outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * The app's short tooltip, as a one-liner: `<Tip label="Close tab"><Button …/></Tip>`.
 * The child stays the element (asChild), so it must take a ref and spread props (shadcn
 * Button, a DOM element, a Radix trigger with asChild). No label: it never opens.
 * Text is xs, wraps at max-w-80 and keeps "\n" line breaks. The app root's
 * TooltipProvider sets the delays.
 *
 * - `whenTruncated` for a label that repeats the trigger's own text: it opens only while
 *   that text is cut short.
 * - A disabled button gets no pointer events: wrap it in a span first (CommandButton).
 * - Around a Radix menu or popover trigger, Tip goes outside it (`<Tip><DropdownMenuTrigger
 *   asChild>…`). Both set `data-state` on the element and the tooltip's wins, so style the
 *   open trigger with `aria-expanded:` rather than `data-[state=open]:`.
 * - It opens on hover and on focus reached by keyboard navigation, not on the focus a
 *   closing menu hands back to its trigger or a dialog gives its first button (`wanted`).
 */
function Tip({
  label,
  children,
  side = "top",
  align = "center",
  sideOffset,
  whenTruncated = false,
  className,
  "data-testid": testId,
}: {
  label: React.ReactNode
  children: React.ReactElement
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"]
  sideOffset?: number
  /** Open only while the trigger's text is cut short (truncate, line-clamp, sr-only, in it or inside it): the label then shows what is hidden. */
  whenTruncated?: boolean
  className?: string
  "data-testid"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(listenForNavKeys, [])
  // Without a label the trigger stays in place (no remount, focus kept) and never opens.
  const has = label !== null && label !== undefined && label !== false && label !== ""
  return (
    <Tooltip
      open={has && open}
      onOpenChange={(next) => {
        setOpen(next && wanted(triggerRef.current) && (!whenTruncated || truncated(triggerRef.current)))
      }}
      disableHoverableContent
    >
      <TooltipTrigger asChild ref={triggerRef}>
        {children}
      </TooltipTrigger>
      {has && (
        <TooltipContent side={side} align={align} sideOffset={sideOffset} className={cn("max-w-80 px-2.5 py-1.5 text-xs break-words whitespace-pre-line", className)} data-testid={testId}>
          {label}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

/**
 * Whether a tooltip may open now. An open while its trigger does not hold the focus came
 * from the pointer. With the focus, only a hovered trigger or one just reached with a
 * navigation key (Tab, arrows) opens it: not the focus a closing menu hands back to its
 * trigger, or a dialog gives its first button, away from the pointer.
 */
function wanted(el: HTMLElement | null): boolean {
  if (!el || !el.contains(document.activeElement)) return true
  if (performance.now() - navKeyAt < 500) return true
  try {
    return el.matches(":hover")
  } catch {
    return true
  }
}

/**
 * Whether the trigger's text is cut short: the trigger or an element inside it overflows
 * its box (truncate, line-clamp, overflow-hidden, sr-only).
 */
function truncated(el: HTMLElement | null): boolean {
  if (!el) return true
  const overflows = (e: Element) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight
  return overflows(el) || Array.from(el.querySelectorAll("*")).some(overflows)
}

const NAV_KEYS = new Set(["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"])
let navKeyAt = -Infinity
let listening = false

/**
 * Records when a navigation key went down (capture phase, before the focus moves); any
 * other key or a pointer press since then forgets it.
 */
function listenForNavKeys() {
  if (listening || typeof document === "undefined") return
  listening = true
  document.addEventListener(
    "keydown",
    (e) => {
      navKeyAt = NAV_KEYS.has(e.key) ? performance.now() : -Infinity
    },
    true
  )
  document.addEventListener(
    "pointerdown",
    () => {
      navKeyAt = -Infinity
    },
    true
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Tip }
