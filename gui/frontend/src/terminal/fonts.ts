/**
 * The bundled terminal font. public/fonts holds JetBrainsMono Nerd Font Mono (Regular and
 * Bold), declared with @font-face in src/index.css, so Nerd Font glyphs render without the
 * user installing anything. This module is the one source of the default font stack.
 *
 * xterm measures cell metrics when it opens (and the WebGL addon builds its glyph atlas
 * from them), so a terminal opened before the web font loaded measures the fallback font.
 * main.tsx awaits loadBundledFont() before the first render, and mounted renderers
 * re-measure on onBundledFontLoaded() in case the load finished after that.
 */

/** Family name inside the TTFs (fc-scan); must match the @font-face rules in index.css. */
export const BUNDLED_FONT_FAMILY = "JetBrainsMono Nerd Font Mono";

/** Always appended to appearance.font_family, so a missing font still renders. */
export const FONT_FALLBACKS = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';

/** Default terminal font-family: the bundled font, then an installed JetBrains Mono, then
 * SF Mono (exposed to WebKit as ui-monospace) and Menlo. */
export const DEFAULT_TERMINAL_FONT_FAMILY = `"${BUNDLED_FONT_FAMILY}", "JetBrains Mono", ${FONT_FALLBACKS}`;

/** Weights with a bundled face; xterm draws bold with fontWeightBold (700) and synthesizes italic. */
const WEIGHTS = ["400", "700"] as const;

const DEFAULT_TIMEOUT_MS = 1000;

/** document.fonts, or undefined where the FontFaceSet API is missing (jsdom). */
function documentFonts(): FontFaceSet | undefined {
  return typeof document === "undefined" ? undefined : (document as Partial<Pick<Document, "fonts">>).fonts;
}

/**
 * Loads the bundled faces. Resolves true once both loaded, false if the API is missing,
 * a load failed, or timeoutMs passed first. Never rejects, so callers can gate startup on
 * it without a failure blocking the UI.
 */
export async function loadBundledFont(fonts: FontFaceSet | undefined = documentFonts(), timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  if (!fonts || typeof fonts.load !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  const load = Promise.all(WEIGHTS.map((w) => fonts.load(`${w} 12px "${BUNDLED_FONT_FAMILY}"`))).then(
    (faces) => faces.every((f) => f.length > 0),
    () => false,
  );
  try {
    return await Promise.race([load, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function unquote(family: string): string {
  return family.replace(/^["']|["']$/g, "");
}

/**
 * Calls cb whenever a bundled face finishes loading (FontFaceSet "loadingdone"). Returns
 * an unsubscribe function; a no-op where the FontFaceSet API is missing.
 */
export function onBundledFontLoaded(cb: () => void, fonts: FontFaceSet | undefined = documentFonts()): () => void {
  if (!fonts || typeof fonts.addEventListener !== "function") return () => undefined;
  const listener = (e: Event) => {
    if ((e as FontFaceSetLoadEvent).fontfaces.some((f) => unquote(f.family) === BUNDLED_FONT_FAMILY)) cb();
  };
  fonts.addEventListener("loadingdone", listener);
  return () => {
    fonts.removeEventListener("loadingdone", listener);
  };
}
