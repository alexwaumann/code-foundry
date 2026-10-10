import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_FONT_FAMILY, DEFAULT_TERMINAL_FONT_FAMILY, loadBundledFont, onBundledFontLoaded } from "./fonts";

/** Minimal FontFaceSet: load() is supplied per test; events go through an EventTarget. */
interface FakeFonts {
  set: FontFaceSet;
  load: ReturnType<typeof vi.fn<(font: string) => Promise<FontFace[]>>>;
  fire: (families: string[]) => void;
}

function fakeFonts(impl: (font: string) => Promise<FontFace[]>): FakeFonts {
  const target = new EventTarget();
  const load = vi.fn(impl);
  const set = {
    load,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const fire = (families: string[]) => {
    const e = new Event("loadingdone");
    Object.assign(e, { fontfaces: families.map((family) => ({ family })) });
    target.dispatchEvent(e);
  };
  return { set: set as unknown as FontFaceSet, load, fire };
}

const face = { family: BUNDLED_FONT_FAMILY } as FontFace;

afterEach(() => {
  vi.useRealTimers();
});

describe("DEFAULT_TERMINAL_FONT_FAMILY", () => {
  it("puts the bundled font first, then JetBrains Mono and the system fallbacks", () => {
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toMatch(/^"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SF Mono", .*monospace$/);
  });
});

describe("loadBundledFont", () => {
  it("is false without the FontFaceSet API (jsdom)", async () => {
    expect(document.fonts).toBeUndefined();
    expect(await loadBundledFont()).toBe(false);
  });

  it("loads the regular and bold faces", async () => {
    const fonts = fakeFonts(() => Promise.resolve([face]));
    expect(await loadBundledFont(fonts.set)).toBe(true);
    expect(fonts.load).toHaveBeenCalledWith(`400 12px "${BUNDLED_FONT_FAMILY}"`);
    expect(fonts.load).toHaveBeenCalledWith(`700 12px "${BUNDLED_FONT_FAMILY}"`);
  });

  it.each([
    ["no face matched", () => Promise.resolve([])],
    ["the load failed", () => Promise.reject(new Error("network"))],
  ])("is false when %s", async (_name, load) => {
    expect(await loadBundledFont(fakeFonts(load).set)).toBe(false);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const pending = loadBundledFont(
      fakeFonts(() => new Promise<FontFace[]>(() => undefined)).set,
      500,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(false);
  });
});

describe("onBundledFontLoaded", () => {
  it("fires for the bundled family only, until unsubscribed", () => {
    const fonts = fakeFonts(() => Promise.resolve([]));
    const cb = vi.fn();
    const stop = onBundledFontLoaded(cb, fonts.set);
    fonts.fire(["Inter"]);
    expect(cb).not.toHaveBeenCalled();
    fonts.fire([`"${BUNDLED_FONT_FAMILY}"`]);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    fonts.fire([BUNDLED_FONT_FAMILY]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without the FontFaceSet API", () => {
    expect(() => {
      onBundledFontLoaded(vi.fn())();
    }).not.toThrow();
  });
});
