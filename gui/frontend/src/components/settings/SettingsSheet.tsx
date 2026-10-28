import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ThemesPage } from "@/components/themes/ThemesPage";
import { useUiStore } from "@/stores/ui";
import { closeSettings, closeSheet, selectSheetOpen, themesEscape, useViewsStore } from "@/stores/views";
import { SettingsPage } from "./SettingsPage";

type SheetBody = "settings" | "themes";

/**
 * Escape in the sheet (Radix calls this only when the sheet is the top layer: a dialog,
 * select, menu or popover over it takes its own Escape and the sheet stays). The sheet
 * decides, so Radix never dismisses it on its own:
 *  - the keybinding recorder (Settings → Keybindings) records Escape as a cancel;
 *  - a field keeps it (a text setting reverts, a search clears its text), except an empty
 *    search, where Escape means "close";
 *  - otherwise Settings closes the sheet, and Themes steps back (themesEscape: out of the
 *    editor's colour view, out of the editor, then back to Settings or closed).
 */
function onSheetEscape(e: KeyboardEvent, body: SheetBody): void {
  e.preventDefault();
  const t = e.target;
  if (t instanceof HTMLElement) {
    if (t.closest("[data-key-recorder]")) return;
    const emptySearch = t instanceof HTMLInputElement && t.type === "search" && t.value === "";
    if (!emptySearch && t.matches('input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="combobox"]')) return;
  }
  if (body === "themes") themesEscape();
  else closeSettings();
}

/**
 * The settings sheet (docs/notes/settings-sheet.md): Settings (view.settings, cmd+,) and
 * the Themes page (theme.pick, theme.edit, Settings → Appearance's Choose…) in one modal
 * over the window, at DialogContent's "sheet" size. stores/views.ts stays the source of
 * truth: the sheet is open while settingsOpen or themesOpen is, and shows the one that is.
 * Going from Settings to Themes and back swaps the body inside the open sheet.
 *
 * A click on the backdrop (or the toggle) closes the whole sheet (closeSheet); the ×
 * and Escape close the body shown, so Themes opened from Settings goes back there.
 *
 * Focus: the body's [data-sheet-focus] takes it on open (Settings its search, Themes its
 * list) rather than Radix's first tabbable; a body swapped in focuses it too (their own
 * effects). On close a thread's prompt takes it back (closeSettings
 * asks for it); elsewhere Radix returns it to what had it before the sheet opened.
 */
export function SettingsSheet() {
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  const themesOpen = useViewsStore((s) => s.themesOpen);
  const open = useViewsStore(selectSheetOpen);
  const shown: SheetBody | null = themesOpen ? "themes" : settingsOpen ? "settings" : null;
  // While the sheet fades out (both flags off), it keeps the body it showed.
  const [last, setLast] = useState<SheetBody>("settings");
  if (shown !== null && shown !== last) setLast(shown);
  const body = shown ?? last;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeSheet();
      }}
    >
      <DialogContent
        size="sheet"
        aria-describedby={undefined}
        data-testid="settings-sheet"
        data-body={body}
        onEscapeKeyDown={(e) => {
          onSheetEscape(e, body);
        }}
        onOpenAutoFocus={(e) => {
          // The body's own first focus ([data-sheet-focus]) rather than the first tabbable.
          const first = e.currentTarget instanceof HTMLElement ? e.currentTarget.querySelector<HTMLElement>("[data-sheet-focus]") : null;
          if (!first) return;
          e.preventDefault();
          first.focus();
        }}
        onInteractOutside={(e) => {
          // A toast's button (a theme card's Undo, "Show in Settings") is not the backdrop.
          if (e.target instanceof Element && e.target.closest("[data-sonner-toaster]")) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          if (useUiStore.getState().selection.kind === "thread") e.preventDefault();
        }}
      >
        {body === "themes" ? <ThemesPage /> : <SettingsPage />}
      </DialogContent>
    </Dialog>
  );
}
