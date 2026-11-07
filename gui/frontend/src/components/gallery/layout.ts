/**
 * The gallery's sizes and moves: what can be worked out without a browser. Pure.
 * docs/notes/gallery-surface.md.
 */
import type { GalleryImage } from "@/surfaces/galleryTarget";

/** The grid's padding and the gap between tiles (the panel's p-3 and gap-3). */
export const GRID_PAD = 12;
export const GRID_GAP = 12;
/** A tile is at least this wide, while more than two columns fit. */
export const TILE_MIN = 200;
/** A tile's shape: a screen, which is what a gallery mostly shows. */
const TILE_ASPECT = 16 / 10;
/** The caption's line under a tile, with the gap above it (mt-1.5 and text-caption). */
const CAPTION_BLOCK = 26;

/** A filmstrip thumbnail's size, and the gap between them. */
export const FILM_WIDTH = 64;
export const FILM_HEIGHT = 40;
export const FILM_GAP = 8;

/** Columns for a box `width` wide: as many as fit at TILE_MIN, and two even in the narrowest panel. */
export function gridColumns(width: number): number {
  return Math.max(2, Math.floor((width - 2 * GRID_PAD + GRID_GAP) / (TILE_MIN + GRID_GAP)));
}

/** A tile's height, and the height of a row of them with its caption and gap, in a box `width` wide. */
export function gridRow(width: number, columns: number): { tile: number; row: number } {
  const tileWidth = (width - 2 * GRID_PAD - (columns - 1) * GRID_GAP) / columns;
  const tile = Math.max(1, Math.round(tileWidth / TILE_ASPECT));
  return { tile, row: tile + CAPTION_BLOCK + GRID_GAP };
}

/**
 * What a key does in the single view at image `at` of `count`: the image to show, "grid" to go
 * back, or null when it is not the view's key. The ends hold: there is no wrap to lose your
 * place in.
 */
export function singleKey(chord: string, at: number, count: number): number | "grid" | null {
  switch (chord) {
    case "escape":
      return "grid";
    case "arrowleft":
    case "arrowup":
      return Math.max(0, at - 1);
    case "arrowright":
    case "arrowdown":
      return Math.min(count - 1, at + 1);
    default:
      return null;
  }
}

/**
 * Where the single view goes when a re-open replaces the images: the same file if it is still
 * there, else back to the grid (null).
 */
export function followOpen(before: readonly GalleryImage[], after: readonly GalleryImage[], at: number | null): number | null {
  if (at === null) return null;
  const path = before[at]?.path;
  const next = after.findIndex((i) => i.path === path);
  return next < 0 ? null : next;
}
