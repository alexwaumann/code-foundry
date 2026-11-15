import { useEffect, useMemo, useState } from "react";
import { useActiveTheme } from "@/lib/theme";
import type { Theme } from "@/themes";
import { MAX_DIAGRAM_CHARS } from "./diagramInfo";
import { diagramThemeOf, type DiagramTheme } from "./mermaidTheme";
import type { RenderedDiagram } from "./types";

/**
 * Renders made, by theme and text, so a view that mounts again (Diagram → Source → Diagram,
 * a markdown file read again) shows its diagram at once instead of drawing it again. A
 * render is a few KB of markup; the oldest go past the cap.
 */
const cache = new Map<string, RenderedDiagram>();
const CACHE_MAX = 32;

function remember(key: string, r: RenderedDiagram): void {
  cache.delete(key);
  cache.set(key, r);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** For tests: forget every render. */
export function clearDiagramCache(): void {
  cache.clear();
}

const looks = new WeakMap<Theme, { look: DiagramTheme; key: string }>();

/** A theme's look and its key, once per Theme object (a theme whose colours change is a new object). */
function lookOf(theme: Theme): { look: DiagramTheme; key: string } {
  let e = looks.get(theme);
  if (!e) {
    const look = diagramThemeOf(theme);
    e = { look, key: JSON.stringify(look) };
    looks.set(theme, e);
  }
  return e;
}

/** What a diagram's text is before Mermaid sees it: nothing to draw, or more than Mermaid draws. */
export function precheck(source: string): RenderedDiagram | null {
  if (source.trim() === "") return { ok: false, message: "The diagram is empty." };
  if (source.length > MAX_DIAGRAM_CHARS) return { ok: false, message: `The diagram is ${String(Math.ceil(source.length / 1000))}K characters; Mermaid draws up to ${String(MAX_DIAGRAM_CHARS / 1000)}K.` };
  return null;
}

export interface MermaidState {
  /** The latest finished render: null until the first one ends. While the text or theme changes it stays the last one, so nothing blinks. */
  readonly result: RenderedDiagram | null;
  /** A render for the current text and theme is still running. */
  readonly pending: boolean;
}

/**
 * Draws `source` with Mermaid in the app's active theme, again when either changes. The
 * library loads on the first call (render.ts is its own chunk).
 */
export function useMermaid(source: string): MermaidState {
  const theme = useActiveTheme();
  const { look, key: themeKey } = lookOf(theme);
  const key = `${themeKey}\u0000${source}`;
  const early = useMemo(() => precheck(source), [source]);
  const [done, setDone] = useState<{ key: string; result: RenderedDiagram } | null>(() => {
    const hit = cache.get(key);
    return hit ? { key, result: hit } : null;
  });
  const current = early ?? (done?.key === key ? done.result : cache.get(key));
  useEffect(() => {
    if (early || cache.has(key)) return;
    let live = true;
    void import("./render")
      .then(
        // A render's outcome is the text's: kept. The library failing to load is not, so the next mount tries again.
        (m) =>
          m.renderDiagram(source, look).then((r) => {
            remember(key, r);
            return r;
          }),
        (e: unknown): RenderedDiagram => ({ ok: false, message: `Mermaid did not load: ${e instanceof Error ? e.message : String(e)}` }),
      )
      .then((result) => {
        if (live) setDone({ key, result });
      });
    return () => {
      live = false;
    };
  }, [early, key, source, look]);
  return { result: current ?? done?.result ?? null, pending: current === undefined };
}
