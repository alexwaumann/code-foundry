"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

/**
 * shadcn's Progress (new-york). Without a `value` (null or undefined, Radix's
 * indeterminate state) the indicator is a third-wide bar sliding across the track
 * (`cf-indeterminate` in index.css): the update dialog's download and restart report no
 * fraction, only the installer's last line.
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const indeterminate = value === null || value === undefined
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full flex-1 rounded-[inherit] bg-primary",
          indeterminate
            ? "w-1/3 animate-[cf-indeterminate_1.4s_ease-in-out_infinite]"
            : "w-full transition-all"
        )}
        style={indeterminate ? undefined : { transform: `translateX(-${String(100 - value)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
