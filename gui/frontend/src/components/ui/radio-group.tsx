import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { CircleIcon } from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

/**
 * shadcn's RadioGroup (new-york): one tab stop, arrow keys move the choice. Checked is
 * styled from `aria-checked`, not Radix's `data-state`: a `Tip` (tooltip) around an item
 * sets its own `data-state` on the same element (docs/notes/theme-3-tooltips.md).
 *
 * Besides shadcn's round `RadioGroupItem`, `RadioGroupChoice` is an item that shows its
 * own children instead of the dot: `variant="segment"` inside a
 * `<RadioGroup variant="segmented">` (a segmented control, the Publish visibility;
 * `size="sm"` is the compact one in panel headers and the Usage page), or
 * `variant="tile"` (an icon over a label, the action editor's icons; the caller lays the
 * tiles out).
 */
const radioGroupVariants = cva("", {
  variants: {
    variant: {
      default: "grid gap-3",
      segmented: "inline-flex w-fit items-center bg-muted [--wails-draggable:no-drag]",
    },
    size: {
      default: "",
      sm: "",
    },
  },
  compoundVariants: [
    { variant: "segmented", size: "default", className: "h-8 rounded-lg p-[3px]" },
    { variant: "segmented", size: "sm", className: "shrink-0 rounded-md p-0.5" },
  ],
  defaultVariants: {
    variant: "default",
    size: "default",
  },
})

type SegmentSize = NonNullable<VariantProps<typeof radioGroupVariants>["size"]>

/** The segmented group's size, for its choices. */
const SegmentSizeContext = React.createContext<SegmentSize>("default")

function RadioGroup({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root> &
  VariantProps<typeof radioGroupVariants>) {
  return (
    <SegmentSizeContext.Provider value={size ?? "default"}>
      <RadioGroupPrimitive.Root
        data-slot="radio-group"
        data-variant={variant}
        data-size={size}
        className={cn(radioGroupVariants({ variant, size }), className)}
        {...props}
      />
    </SegmentSizeContext.Provider>
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

const radioGroupChoiceVariants = cva(
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
  {
    variants: {
      variant: {
        segment:
          "inline-flex h-full items-center gap-1.5 border border-transparent font-medium whitespace-nowrap text-foreground/70 hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm dark:aria-checked:border-input dark:aria-checked:bg-input/30 [&_svg]:size-3.5",
        tile: "flex flex-col items-center gap-1.5 rounded-md border border-border/70 px-1 pt-2 pb-1.5 text-caption hover:bg-accent/50 hover:text-foreground aria-checked:border-primary/70 aria-checked:bg-primary/10 aria-checked:text-foreground dark:border-transparent dark:bg-foreground/[0.035] dark:aria-checked:border-transparent dark:aria-checked:bg-primary/10 dark:aria-checked:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_30%,transparent)] [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "segment",
    },
  }
)

/** A segment's corners, padding and type per group size (an inner corner one step under the group's). */
const segmentSizes: Record<SegmentSize, string> = {
  default: "rounded-md px-2.5 text-body-sm",
  sm: "rounded-sm px-2 py-0.5 text-caption-sm",
}

function RadioGroupChoice({
  className,
  variant = "segment",
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> &
  VariantProps<typeof radioGroupChoiceVariants>) {
  const size = React.useContext(SegmentSizeContext)
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-choice"
      data-variant={variant}
      className={cn(radioGroupChoiceVariants({ variant }), variant === "segment" && segmentSizes[size], className)}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupChoice }
