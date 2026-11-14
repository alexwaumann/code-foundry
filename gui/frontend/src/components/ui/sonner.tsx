import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"

/**
 * The toast card (docs/notes/toast-levels.md). Sonner draws it unstyled and these classes
 * are the whole look, so the app and a page (@cf/ui, whose stylesheet scans this file) get
 * the same card. A grid: the icon on the title line, the title and description in the
 * next column (the description hangs under the title, not the icon), the close button at
 * the title line's end, and the buttons on their own row under the body:
 *
 *   [icon] [title ............................] [×]
 *          [description ......................]
 *          [cancel] [action]
 *
 * Columns: icon (16px, then 8px), cancel, action, the rest, close. The body spans the
 * middle three; a toast without a cancel or a close leaves its column empty (0 wide).
 *
 * A level tints the card: its `-surface` slot (translucent) layered over the overlay
 * surface, so the card is opaque and a user theme's tint carries through, and a border
 * mixed from its hue. The level's classes only set the --level-* properties the card reads
 * (each read has the neutral fallback, which loading and a page's level-less toast keep).
 */
const card = [
  "grid w-(--width) grid-cols-[1.5rem_auto_auto_minmax(0,1fr)_auto] items-start rounded-pane border py-3 pl-3 pr-3.5 shadow-lg",
  "bg-cf-surface-overlay bg-[linear-gradient(var(--level-surface,transparent),var(--level-surface,transparent))] border-(--level-border,var(--cf-border)) text-cf-text",
  // A stacked toast behind the front one shows only its card, as sonner's own style does.
  "data-[expanded=false]:data-[front=false]:*:opacity-0",
].join(" ")

/** A level's hue, its tint and its text colour, for the card's classes above. */
function level(name: "success" | "info" | "warning" | "error"): string {
  return {
    success: "[--level:var(--cf-success)] [--level-surface:var(--cf-success-surface)] [--level-text:var(--cf-success-text)] [--level-border:color-mix(in_oklab,var(--cf-success)_32%,var(--cf-surface-overlay))]",
    info: "[--level:var(--cf-info)] [--level-surface:var(--cf-info-surface)] [--level-text:var(--cf-info-text)] [--level-border:color-mix(in_oklab,var(--cf-info)_32%,var(--cf-surface-overlay))]",
    warning: "[--level:var(--cf-warning)] [--level-surface:var(--cf-warning-surface)] [--level-text:var(--cf-warning-text)] [--level-border:color-mix(in_oklab,var(--cf-warning)_32%,var(--cf-surface-overlay))]",
    error: "[--level:var(--cf-error)] [--level-surface:var(--cf-error-surface)] [--level-text:var(--cf-error-text)] [--level-border:color-mix(in_oklab,var(--cf-error)_32%,var(--cf-surface-overlay))]",
  }[name]
}

const button = "row-start-2 col-start-2 mt-2 inline-flex h-6 items-center rounded-sm px-2 text-body-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/50"

const classNames: NonNullable<ToasterProps["toastOptions"]>["classNames"] = {
  toast: card,
  success: level("success"),
  info: level("info"),
  warning: level("warning"),
  error: level("error"),
  // relative: sonner centres its loader absolutely in this box.
  icon: "relative col-start-1 row-start-1 flex size-4 mt-px text-(--level,var(--cf-text-muted)) [&_svg]:size-4",
  content: "col-start-2 col-end-5 row-start-1 flex min-w-0 flex-col gap-0.5",
  title: "text-body-sm font-semibold text-(--level-text,var(--cf-text)) [overflow-wrap:anywhere]",
  description: "text-body-sm text-cf-text-secondary [overflow-wrap:anywhere]",
  closeButton:
    "col-start-5 row-start-1 -mr-1 ml-2 flex size-5 items-center justify-center rounded-sm text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-2 focus-visible:ring-cf-focus/50",
  // Neutral whatever the level: the action is the strong one, a cancel the quiet one beside it.
  cancelButton: `${button} bg-cf-text/10 text-cf-text hover:bg-cf-text/15`,
  actionButton: `${button} bg-cf-text text-cf-surface-overlay hover:opacity-90 [[data-cancel]+&]:col-start-3 [[data-cancel]+&]:ml-1.5`,
}

/**
 * shadcn's sonner wrapper, styled for the app (above). Sonner's own theme stays light
 * whatever `theme` says: the colours are the cf slots, which follow the scheme, and its dark
 * sheet recolours a description and the close button with unlayered rules that would win
 * over these (layered) utilities.
 */
function Toaster({ toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon />,
        info: <InfoIcon />,
        warning: <TriangleAlertIcon />,
        error: <OctagonXIcon />,
        loading: <Loader2Icon className="animate-spin" />,
        close: <XIcon className="size-3.5" />,
      }}
      {...props}
      theme="light"
      toastOptions={{ ...toastOptions, unstyled: true, classNames: withClassNames(toastOptions?.classNames) }}
    />
  )
}

/** The card's classes with a caller's (a page's Toaster) after them, key by key. */
function withClassNames(extra: typeof classNames): typeof classNames {
  if (!extra) return classNames
  const out: Record<string, string | undefined> = { ...classNames }
  for (const [key, value] of Object.entries(extra)) out[key] = [out[key], value].filter(Boolean).join(" ")
  return out
}

/** Sonner's toast, for a page's own Toaster (@cf/ui). The app shows its toasts with lib/notify. */
export { Toaster, toast }
