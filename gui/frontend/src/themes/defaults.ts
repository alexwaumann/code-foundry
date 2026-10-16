/**
 * The default theme of each scheme. Its own module so themes/convert.ts can write them into
 * the daemon's copy of the catalog (internal/theme/catalog.json) without importing the
 * generated catalog it is about to replace.
 */
export const DEFAULT_LIGHT = "github-light";
export const DEFAULT_DARK = "github-dark";
