/**
 * Side-panel surfaces, in the order the empty panel lists them. A surface is one file
 * exporting a SurfaceSpec (see types.ts); list it here. The panel finds renderers,
 * hotkeys and availability through these lookups, never by switching on the kind.
 */
import type { SurfaceKind } from "@/stores/panel";
import { diffSurface } from "./diff";
import { filesSurface } from "./files";
import { pullRequestSurface } from "./pullrequest";
import type { SurfaceAvailability, SurfaceContext, SurfaceSpec } from "./types";

export type { SurfaceAvailability, SurfaceContext, SurfaceSpec } from "./types";

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

/** Surfaces to list for a selection, with their availability; hidden ones are left out. */
export function listedSurfaces(ctx: SurfaceContext): { spec: SurfaceSpec; availability: Exclude<SurfaceAvailability, "hidden"> }[] {
  return surfaces.flatMap((spec) => {
    const availability = spec.available(ctx);
    return availability === "hidden" ? [] : [{ spec, availability }];
  });
}
