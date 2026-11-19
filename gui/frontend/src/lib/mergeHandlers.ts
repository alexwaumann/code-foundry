import type { SyntheticEvent } from "react";

type Handler = (e: SyntheticEvent) => void;

/** Each of `extra`'s handlers (dnd-kit's listeners) called after the one `props` has for the same event. */
export function mergeHandlers(props: object, extra: object | undefined): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  const own = props as Record<string, unknown>;
  for (const [name, fn] of Object.entries(extra ?? {}) as [string, unknown][]) {
    if (typeof fn !== "function") continue;
    const next = fn as Handler;
    const first = own[name];
    out[name] =
      typeof first === "function"
        ? (e) => {
            (first as Handler)(e);
            next(e);
          }
        : next;
  }
  return out;
}
