/**
 * lib/zoom.ts for the page library (vite.pagelib.config.ts aliases it): a page in a frame
 * has no app zoom, so Radix offsets stay as given. Same exports as the app's.
 */
export function useZoomFactor(): number {
  return 1;
}

export function zoomPx<T extends number | Partial<Record<"top" | "right" | "bottom" | "left", number>> | undefined>(value: T, factor: number): T {
  if (value === undefined || factor === 1) return value;
  if (typeof value === "number") return (value * factor) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v * factor])) as T;
}
