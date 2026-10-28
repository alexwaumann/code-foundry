import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

/**
 * Every modal's backdrop (docs/notes/modal-backdrop.md): the theme's scrim slot (a 50% dim
 * on dark themes, 30% on light) over a 1px blur, so the window under a dialog, the palette or
 * help reads as behind it. Only the opacity animates: the blur radius stays fixed, since animating
 * backdrop-filter over the terminal canvas and page frames stutters in WebKit. A dialog may
 * pass a darker scrim (overlayClassName, the attachment lightbox).
 */
function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-cf-scrim backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * The sizes a dialog comes in. "default": the dialog's own width (its className), its top
 * 14% down the window. "sheet": an app-level page in a modal (Settings, Themes, Usage;
 * docs/notes/settings-sheet.md), centred, at most 1280 by 1280 and never closer than 48px
 * to a window edge, so it shrinks with the window. Viewport units divide by --cf-zoom
 * (lib/zoom.ts: the page zoom would scale them twice); the px values zoom with the page.
 * The sheet is a flex column that clips: its body lays out its own scrolling regions.
 */
const dialogSizes = {
  default: "top-[calc(14vh/var(--cf-zoom))] w-full max-w-[calc(100%-2rem)]",
  sheet:
    "top-1/2 flex h-[min(1280px,calc(100vh/var(--cf-zoom)-96px))] w-[min(1280px,calc(100vw/var(--cf-zoom)-96px))] max-w-none -translate-y-1/2 flex-col overflow-hidden",
} as const

function DialogContent({
  className,
  overlayClassName,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string; size?: keyof typeof dialogSizes }) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size}
        className={cn(
          "fixed left-1/2 z-50 -translate-x-1/2 rounded-pane border bg-popover shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          dialogSizes[size],
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/** The title and description's stack, shadcn's names; the app's dialogs lay out their own. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1", className)} {...props} />
}

/** The buttons' row, at the end. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex justify-end gap-2", className)} {...props} />
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-heading", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-caption", className)}
      {...props}
    />
  )
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
