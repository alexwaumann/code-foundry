/**
 * A plugin surface under test, driven like the real one (components/plugin/layoutfuzz.test.tsx,
 * layoutprobe.test.tsx): the store's watch "w" holds the view (pushView runs the reducers
 * stores/pluginSurfaces onUpdate runs), Surface draws it like PluginSurface (frame, view
 * tabs, strips, the body's box list). jsdom has no layout: installGeometry gives every
 * element `geo.width` (or its data-key's box) and the scroll area and fill boxes a height,
 * and a ResizeObserver stub that counts what it observes (a leak check) and fires on resize().
 */
/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
import { act } from "@testing-library/react";
import { useMemo } from "react";
import { vi } from "vitest";
import type { PluginViewModel } from "@/api/plugin";
import { ViewContext, type ViewCtx } from "@/components/plugin/context";
import { NodeList } from "@/components/plugin/NodeList";
import { SurfaceFrame } from "@/components/plugin/SurfaceFrame";
import { ViewTabsBar } from "@/components/plugin/ViewTabsBar";
import { emptyContext } from "@/stores/context";
import { applyUpdateToState, emptyEntry, usePluginSurfacesStore } from "@/stores/pluginSurfaces";

export const INSTANCE = "fuzz/surface/global";

export interface Box {
  top: number;
  height: number;
  width: number;
}

/** The fake layout: the default width, the scroll area's height, and boxes by data-key (or "scroll-root"). */
export const geo: { width: number; height: number; boxes: Record<string, Partial<Box>>; observed: number; observers: Set<() => void> } = {
  width: 360,
  height: 700,
  boxes: {},
  observed: 0,
  observers: new Set(),
};

function boxOf(el: Element): Box {
  const scroll = el.hasAttribute("data-scroll-root");
  const b = (scroll ? geo.boxes["scroll-root"] : geo.boxes[el.getAttribute("data-key") ?? ""]) ?? {};
  return { top: b.top ?? 0, height: b.height ?? (scroll || el.hasAttribute("data-fill-box") ? geo.height : 0), width: b.width ?? geo.width };
}

export function installGeometry(): void {
  geo.width = 360;
  geo.height = 700;
  geo.boxes = {};
  geo.observed = 0;
  geo.observers = new Set();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const b = boxOf(this);
    return { top: b.top, bottom: b.top + b.height, left: 0, right: b.width, width: b.width, height: b.height, x: 0, y: b.top, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return boxOf(this).height;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: () => void;
      readonly els = new Set<Element>();
      constructor(cb: ResizeObserverCallback) {
        this.cb = () => {
          const entries = [...this.els].map((target) => {
            const b = boxOf(target);
            const size = [{ inlineSize: b.width, blockSize: b.height }];
            return { target, contentRect: target.getBoundingClientRect(), borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
          });
          if (entries.length > 0) cb(entries, this);
        };
      }
      observe(el: Element): void {
        if (!this.els.has(el)) geo.observed++;
        this.els.add(el);
        geo.observers.add(this.cb);
      }
      unobserve(el: Element): void {
        if (this.els.delete(el)) geo.observed--;
        if (this.els.size === 0) geo.observers.delete(this.cb);
      }
      disconnect(): void {
        geo.observed -= this.els.size;
        this.els.clear();
        geo.observers.delete(this.cb);
      }
    },
  );
}

/** Every ResizeObserver fires (after the geometry changed). */
export function resize(width?: number): void {
  if (width !== undefined) geo.width = width;
  act(() => {
    for (const o of [...geo.observers]) o();
  });
}

/** A new view on the watch "w", through the store's reducers (stores/pluginSurfaces onUpdate). */
export function pushView(view: PluginViewModel): void {
  act(() => {
    usePluginSurfacesStore.setState((s) => {
      const e = s.watches.w ?? { ...emptyEntry({ plugin: "fuzz", surface: "surface" }), instance: INSTANCE, phase: "live" as const };
      return applyUpdateToState({ ...s, watches: { ...s.watches, w: e } }, "w", { kind: "view", instance: INSTANCE, version: e.version + 1, view, hostRendered: false });
    });
  });
}

export function resetSurfaceStore(): void {
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {}, submitted: {}, details: {}, choices: {} });
}

/** The watch "w"'s view drawn like PluginSurface. */
export function Surface() {
  const view = usePluginSurfacesStore((s) => s.watches.w?.view ?? null);
  const viewTab = view?.tabs?.active ?? "";
  const ctx = useMemo<ViewCtx>(() => ({ watchKey: "w", instance: INSTANCE, plugin: "fuzz", viewTab, uiContext: emptyContext, inert: false }), [viewTab]);
  if (!view) return null;
  return (
    <ViewContext.Provider value={ctx}>
      <SurfaceFrame top={view.tabs && view.tabs.items.length > 0 ? <ViewTabsBar tabs={view.tabs} /> : null} toolbar={view.toolbar ?? []} footer={view.footer ?? []}>
        <div className="flex grow flex-col" data-testid="plugin-body">
          <NodeList nodes={view.nodes} box />
        </div>
      </SurfaceFrame>
    </ViewContext.Provider>
  );
}
