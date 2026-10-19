import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseView } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoJson, type DemoTab } from "@/test/pluginFixtures";
import { ViewContext, type ViewCtx } from "./context";
import { SurfaceHeader } from "./Header";
import { NodeList } from "./NodeList";
import { SurfaceFrame } from "./SurfaceFrame";
import { ViewTabsBar } from "./ViewTabsBar";

/**
 * Mutated views (docs/notes/plugins-9-fuzz.md): the hello demo's views, mutated the way
 * the daemon's validation and canonical form allow (lists emptied, optional fields
 * dropped, free text empty, long or hostile, numbers at their bounds, elements repeated
 * under new keys), parse and render without throwing. Seeded, so a failure names the seed
 * that reproduces it.
 */

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/thread:s-1", version: 1, plugin: "hello", viewTab: "overview", uiContext: emptyContext, inert: false };

/** mulberry32: a small seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Free text the daemon takes any string for (within limits). */
const TEXT = new Set(["text", "label", "title", "detail", "placeholder", "source", "emptyText", "data", "copy", "tabTitle", "error", "patternMessage"]);
/** Optional fields the daemon lets a view leave out. */
const OPTIONAL = new Set(["icon", "tone", "status", "meta", "pill", "line2", "trailing", "titleMeta", "actions", "action", "glyph", "subline",
  "header", "tabs", "description", "hint", "error", "badge", "selected", "disabled", "busy", "mono", "strong", "url", "rows", "height", "value",
  "options", "lines", "text", "title", "style", "align", "collapsible", "collapsed", "card", "stale", "readOnly", "submit", "secondary",
  "weight", "width", "collapse", "minHeight", "noScroll", "minWidth", "span", "size", "flex", "noWrap", "toolbar", "footer"]);
/** Numbers and the values the daemon accepts for them. */
const NUMBERS: Record<string, readonly number[]> = {
  rows: [0, 4, 40], ms: [0, 1, 59_999, 3_600_000, Number.MAX_SAFE_INTEGER], value: [0, 0.5, 1], maxLength: [0, 1, 10_000], height: [120, 1600],
  weight: [0, 1, 6], width: [160, 640], minHeight: [0, 120, 1600], minWidth: [0, 160, 480], span: [0, 1, 2], size: [0, 4, 64],
};
const strings = ["", " ", "x".repeat(4000), "é\u2028\u0000<script>alert(1)</script>", "**md** `code` [l](javascript:alert(1))", "\n\n\t"];

/** A copy of v with every element key suffixed, so a repeated element keeps keys unique. */
function rekey(v: Json, suffix: string): Json {
  if (Array.isArray(v)) return v.map((x) => rekey(x, suffix));
  if (v !== null && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === "key" && typeof x === "string" ? x + suffix : rekey(x, suffix);
    return out;
  }
  return v;
}

function mutate(v: Json, rand: () => number, field = "", depth = 0): Json {
  if (Array.isArray(v)) {
    const out = v.map((x) => (rand() < 0.3 ? mutate(x, rand, field, depth + 1) : x));
    const r = rand();
    if (r < 0.1) return field === "items" && depth <= 1 ? out : []; // tabs need one item
    if (r < 0.2 && out.length > 0) out.push(rekey(out[0] as Json, `-r${String(depth)}`));
    if (r < 0.25) out.reverse();
    return out;
  }
  if (v !== null && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) {
      const r = rand();
      if (OPTIONAL.has(k) && r < 0.1) continue;
      out[k] = r < 0.4 ? mutate(x, rand, k, depth + 1) : x;
    }
    return out;
  }
  const r = rand();
  if (typeof v === "string" && TEXT.has(field) && r < 0.5) return strings[Math.floor(rand() * strings.length)] ?? "";
  const nums = NUMBERS[field];
  if (typeof v === "number" && nums && r < 0.5) return nums[Math.floor(rand() * nums.length)] ?? 0;
  if (typeof v === "boolean" && r < 0.5) return !v;
  return v;
}

afterEach(() => {
  cleanup();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {} });
});

describe("mutated views", () => {
  const tabs: DemoTab[] = ["overview", "form", "log", "assistant", "shell", "layout", "run-list"];
  it("parse and render without throwing", () => {
    let rendered = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const tab = tabs[seed % tabs.length] ?? "overview";
      const rand = rng(seed);
      const json = JSON.stringify(mutate(JSON.parse(demoJson(tab)) as Json, rand));
      const view = parseView(json);
      if (!view) continue;
      try {
        render(
          <ViewContext.Provider value={{ ...ctx, viewTab: tab }}>
            <SurfaceFrame
              top={
                <>
                  <SurfaceHeader header={view.header} fallbackTitle="Hello" icon="sparkles" />
                  {view.tabs && view.tabs.items.length > 0 && <ViewTabsBar tabs={view.tabs} />}
                </>
              }
              toolbar={view.toolbar ?? []}
              footer={view.footer ?? []}
            >
              <NodeList nodes={view.nodes} />
            </SurfaceFrame>
          </ViewContext.Provider>,
        );
      } catch (e) {
        throw new Error(`seed ${String(seed)} (${tab}): ${String(e)}\n${json.slice(0, 2000)}`, { cause: e });
      }
      cleanup();
      rendered++;
    }
    expect(rendered).toBeGreaterThan(100);
  }, 60_000); // ~1 s alone; the whole suite in parallel can take several
});
