/**
 * Keeps the native window's background on the active theme's sheet (gui/windowbg.go).
 * The page paints the canvas (--cf-canvas) over it, so it only shows before the page loads and while a
 * resize outruns the page; the host saves the colours so the next launch opens in them
 * (docs/notes/theme-engine-3-settings.md).
 */
import { setWindowBackground, type WindowBackgroundView } from "@/api/app";
import { themeById } from "@/themes";
import { activeTheme, onThemeChange, themePreference, themeSlots } from "./theme";

/** The colours to report now. */
export function windowBackground(): WindowBackgroundView {
  const { light, dark } = themeSlots();
  const sheet = (id: string) => themeById.get(id)?.slots["--cf-canvas"] ?? "";
  return { scheme: themePreference(), dark: sheet(dark), light: sheet(light), active: activeTheme().scheme };
}

/**
 * Reports the colours on start and after every change that moves them. `report` is the
 * host call (a parameter for tests). Returns an unsubscribe.
 */
export function syncWindowBackground(report: (bg: WindowBackgroundView) => unknown = setWindowBackground): () => void {
  let last = "";
  const apply = () => {
    const bg = windowBackground();
    const key = JSON.stringify(bg);
    if (key === last) return;
    last = key;
    void report(bg);
  };
  apply();
  return onThemeChange(apply);
}
