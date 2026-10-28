import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useUiStore } from "@/stores/ui";
import { closeUsage, useViewsStore } from "@/stores/views";
import { UsagePage } from "./UsagePage";

/**
 * The Usage sheet (docs/notes/usage-sheet.md): the Usage page (view.usage, the sidebar's
 * chart button) in a modal over the window, at DialogContent's "sheet" size like the
 * settings sheet (components/settings/SettingsSheet.tsx). stores/views.ts stays the
 * source of truth: the sheet is open while usageOpen is, and at most one of the two
 * sheets is (setPages keeps the flags exclusive).
 *
 * Escape, the ×, a click on the backdrop (the chart button sits under it, so it stays a
 * toggle) and view.usage again all close it (closeUsage). The page has no field, so
 * Radix's own Escape is enough: it only reaches the top layer, and a tooltip, the palette
 * or help over the sheet takes its own.
 *
 * Focus: the page's section takes it on open (Radix's first tabbable would be a range
 * button). On close a thread's prompt takes it back (closeUsage asks for it); elsewhere
 * Radix returns it to what had it before the sheet opened.
 */
export function UsageSheet() {
  const open = useViewsStore((s) => s.usageOpen);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeUsage();
      }}
    >
      <DialogContent
        size="sheet"
        aria-describedby={undefined}
        data-testid="usage-sheet"
        onOpenAutoFocus={(e) => {
          const first = e.currentTarget instanceof HTMLElement ? e.currentTarget.querySelector<HTMLElement>("[data-sheet-focus]") : null;
          if (!first) return;
          e.preventDefault();
          first.focus();
        }}
        onInteractOutside={(e) => {
          // A toast's button is not the backdrop (docs/notes/settings-sheet.md, "Toasts over a modal").
          if (e.target instanceof Element && e.target.closest("[data-sonner-toaster]")) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          if (useUiStore.getState().selection.kind === "thread") e.preventDefault();
        }}
      >
        <UsagePage />
      </DialogContent>
    </Dialog>
  );
}
