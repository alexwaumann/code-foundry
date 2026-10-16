import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

/**
 * shadcn's Switch (new-york). Checked and unchecked are styled from `aria-checked`, not
 * Radix's `data-state`: a `Tip` (tooltip) around the switch would set its own `data-state`
 * on the same element (docs/notes/theme-3-tooltips.md).
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 aria-checked:bg-primary aria-[checked=false]:bg-input dark:aria-[checked=false]:bg-input/80",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-aria-checked/switch:translate-x-[calc(100%-2px)] group-aria-[checked=false]/switch:translate-x-0 dark:group-aria-checked/switch:bg-primary-foreground dark:group-aria-[checked=false]/switch:bg-foreground"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
