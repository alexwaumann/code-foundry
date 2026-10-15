import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * shadcn's Kbd (new-york), drawn as the app's key chip: a hairline border on a muted fill.
 * - `size`: `default` (11px, 20px tall) for a chord beside a list row or in the shortcut
 *   list; `sm` (10px, 16px tall) for an inline hint in a footer, a field or a button.
 * - `variant="inherit"`: on a filled or outlined button, the chip takes the button's own
 *   text colour for its text and border, dimmed (the permission prompt's buttons, the
 *   sidebar's New thread).
 */
const kbdVariants = cva(
  "pointer-events-none inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded border font-sans whitespace-nowrap select-none [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default:
          "border-border bg-muted/60 text-muted-foreground [[data-slot=tooltip-content]_&]:border-transparent [[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10",
        inherit: "border-current bg-transparent text-current opacity-50",
      },
      size: {
        default: "h-5 min-w-5 px-1.5 text-[11px]",
        sm: "h-4 min-w-4 px-1 text-[10px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Kbd({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return (
    <kbd
      data-slot="kbd"
      data-variant={variant}
      data-size={size}
      className={cn(kbdVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
