import { useEffect } from "react";
import { useConfirmStore } from "@/stores/confirm";
import { useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";

/**
 * Escape closes a window-level page (settings, usage), unless the palette, help or a
 * confirmation is open, a field (or the key recorder, or a select's trigger) is being
 * edited, or the key comes from inside a floating surface (an open select's list, a
 * menu) or a dialog over the page (a plugin's log): Radix closes that one on the same
 * Escape, and the page stays.
 */
export function useEscapeCloses(close: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (useUiStore.getState().palette.open || useViewsStore.getState().helpOpen || useConfirmStore.getState().pending) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.matches('input, select, textarea, [role="combobox"]') || t.closest('[data-key-recorder], [data-radix-popper-content-wrapper], [role="dialog"]'))) return;
      close();
    };
    // Capture phase: runs before Radix closes a dialog on the same Escape.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [close]);
}
