import { describe, expect, it, vi } from "vitest";
import type { BrowserFrameView } from "@/api/browser";
import { newPainter } from "./useBrowserStream";

const frame = (n: number): BrowserFrameView => ({ jpeg: new Uint8Array([n]), width: 10, height: 10 });

function canvas() {
  const ctx = { drawImage: vi.fn(), clearRect: vi.fn() };
  return { el: { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement, ctx };
}

function image(n: number) {
  return { width: 20, height: 20, n, close: vi.fn() } as unknown as ImageBitmap;
}

describe("newPainter", () => {
  it("decodes one at a time and draws only the newest of what waited", async () => {
    const { el, ctx } = canvas();
    const decoding: ((b: ImageBitmap) => void)[] = [];
    const decoded: number[] = [];
    const { paint } = newPainter(el, (jpeg) => {
      decoded.push(jpeg[0] ?? 0);
      return new Promise((r) => decoding.push(r));
    });
    paint(frame(1));
    paint(frame(2));
    paint(frame(3));
    paint(frame(4));
    expect(decoded).toEqual([1]);
    decoding.shift()?.(image(1));
    await vi.waitFor(() => {
      expect(decoded).toEqual([1, 4]);
    });
    decoding.shift()?.(image(4));
    await vi.waitFor(() => {
      expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    });
    expect(el.width).toBe(20);
  });

  it("closes each image, and goes on after one that does not decode", async () => {
    const { el, ctx } = canvas();
    const good = image(2);
    const { paint } = newPainter(el, (jpeg) => (jpeg[0] === 1 ? Promise.reject(new Error("bad")) : Promise.resolve(good)));
    paint(frame(1));
    await vi.waitFor(() => undefined);
    await Promise.resolve();
    paint(frame(2));
    await vi.waitFor(() => {
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect((good as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    });
  });

  // A page on another site has sent nothing yet: the last page's picture must not stand under its
  // address, and neither may one of its frames still decoding.
  it("clears the canvas and never draws what was decoding or waiting across the clear", async () => {
    const { el, ctx } = canvas();
    const decoding: ((b: ImageBitmap) => void)[] = [];
    const { paint, clear } = newPainter(el, () => new Promise((r) => decoding.push(r)));
    paint(frame(1));
    paint(frame(2));
    clear();
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    const old = image(1);
    decoding.shift()?.(old);
    await vi.waitFor(() => {
      expect((old as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    });
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(decoding).toHaveLength(0);
    paint(frame(3));
    decoding.shift()?.(image(3));
    await vi.waitFor(() => {
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    });
  });
});
