import type { CSSProperties } from "react";
import forestNarrow from "@/assets/backdrop/forest-4-3.webp";
import forestWide from "@/assets/backdrop/forest-16-9.webp";
import { KEYS, useSettingValue } from "@/stores/settings";
import "./backdrop.css";

/** appearance.backdrop values with artwork: a 4:3 and a 16:9 cut of the same picture. */
const ART: Record<string, { narrow: string; wide: string } | undefined> = {
  forest: { narrow: forestNarrow, wide: forestWide },
};

/** Before the first settings snapshot (or against a daemon without the key): the schema default. */
const DEFAULT_BACKDROP = "forest";

/**
 * Faint artwork behind a pane's centred content (the start page, the new-thread
 * composer). Absolutely positioned and inert: put it first in a `relative` container
 * and give the content `relative` so it paints above. Renders nothing for
 * appearance.backdrop = none.
 */
export function Backdrop() {
  const choice = useSettingValue(KEYS.backdrop) ?? DEFAULT_BACKDROP;
  const art = ART[choice];
  if (!art) return null;
  const style = { "--cf-backdrop-narrow": `url("${art.narrow}")`, "--cf-backdrop-wide": `url("${art.wide}")` } as CSSProperties;
  return (
    <div aria-hidden className="cf-backdrop" data-testid="backdrop" data-backdrop={choice}>
      <div className="cf-backdrop-art" style={style} />
    </div>
  );
}
