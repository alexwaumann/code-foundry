import type { CSSProperties } from "react";
import forestNarrow from "@/assets/backdrop/forest-4-3.webp";
import forestWide from "@/assets/backdrop/forest-16-9.webp";
import { CUSTOM_BACKDROP, useBackdropUrl } from "@/stores/backdrops";
import { KEYS, useSettingValue } from "@/stores/settings";
import "./backdrop.css";

/** appearance.backdrop values with bundled artwork: a 4:3 and a 16:9 cut of the same picture. */
const ART: Record<string, { narrow: string; wide: string } | undefined> = {
  forest: { narrow: forestNarrow, wide: forestWide },
};

/** Before the first settings snapshot (or against a daemon without the key): the schema default. */
const DEFAULT_BACKDROP = "forest";

/**
 * Faint artwork behind a pane's centred content (the start page, the new-thread
 * composer). Absolutely positioned and inert: put it first in a `relative` container
 * and give the content `relative` so it paints above. Renders nothing for
 * appearance.backdrop = none. Custom shows the image appearance.backdrop_file names, once
 * it has loaded (nothing meanwhile); with no file named, or the file gone, it falls back
 * to the default's art.
 */
export function Backdrop() {
  const choice = useSettingValue(KEYS.backdrop) ?? DEFAULT_BACKDROP;
  if (choice === CUSTOM_BACKDROP) return <CustomBackdrop />;
  return <BundledBackdrop choice={choice} />;
}

function BundledBackdrop({ choice }: { choice: string }) {
  const art = ART[choice];
  if (!art) return null;
  return <BackdropArt choice={choice} narrow={art.narrow} wide={art.wide} />;
}

/** The user's image, one picture for both aspect ratios. */
function CustomBackdrop() {
  const name = useSettingValue(KEYS.backdropFile) ?? "";
  const { url, loading } = useBackdropUrl(name);
  if (loading) return null;
  if (!url) return <BundledBackdrop choice={DEFAULT_BACKDROP} />;
  return <BackdropArt choice={CUSTOM_BACKDROP} narrow={url} wide={url} />;
}

function BackdropArt({ choice, narrow, wide }: { choice: string; narrow: string; wide: string }) {
  const style = { "--cf-backdrop-narrow": `url("${narrow}")`, "--cf-backdrop-wide": `url("${wide}")` } as CSSProperties;
  return (
    <div aria-hidden className="cf-backdrop" data-testid="backdrop" data-backdrop={choice}>
      <div className="cf-backdrop-art" style={style} />
    </div>
  );
}
