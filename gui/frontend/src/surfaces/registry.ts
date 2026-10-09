/**
 * Side-panel surfaces, in the order the empty panel lists them. A surface is one file
 * exporting a SurfaceSpec (see types.ts); list it here. The panel finds renderers,
 * hotkeys and availability through these lookups, never by switching on the kind.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { SurfaceKind } from "@/stores/panel";
import { diffSurface } from "./diff";
import { filesSurface } from "./files";
import { pullRequestSurface } from "./pullrequest";
import type { SurfaceAvailability, SurfaceContext, SurfaceSpec } from "./types";

export type { Subscribable, SurfaceAvailability, SurfaceContext, SurfaceSpec } from "./types";

export const surfaces: readonly SurfaceSpec[] = [filesSurface, diffSurface, pullRequestSurface];

const byKind = new Map<SurfaceKind, SurfaceSpec>(surfaces.map((s) => [s.kind, s]));
const byHotkey = new Map<string, SurfaceSpec>(surfaces.map((s) => [s.hotkey.toLowerCase(), s]));

export function surfaceOf(kind: SurfaceKind): SurfaceSpec | undefined {
  return byKind.get(kind);
}

/** The surface a bare letter opens (case-insensitive), if any. */
export function surfaceByHotkey(key: string): SurfaceSpec | undefined {
  return byHotkey.get(key.toLowerCase());
}

/**
 * A surface's availability for ctx, kept current: subscribes to the stores the spec
 * `watches` and re-evaluates `available` when any of them changes. The snapshot is a
 * string, so unrelated store updates do not re-render the caller.
 */
export function useAvailability(spec: SurfaceSpec, ctx: SurfaceContext): SurfaceAvailability {
  const { watches } = spec;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = (watches ?? []).map((s) => s.subscribe(onChange));
      return () => {
        for (const stop of stops) stop();
      };
    },
    [watches],
  );
  return useSyncExternalStore(subscribe, () => spec.available(ctx));
}
