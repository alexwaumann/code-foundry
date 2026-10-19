/** A tab's element id in a TabStrip whose ids start with `idBase` (its panel names it: aria-labelledby). */
export function tabElementId(idBase: string, key: string): string {
  return `${idBase}-tab-${key}`;
}
