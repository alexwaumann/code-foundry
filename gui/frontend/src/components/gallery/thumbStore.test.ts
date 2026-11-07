import { describe, expect, it, vi } from "vitest";
import { imageKey, type GalleryImage } from "@/surfaces/galleryTarget";
import { FAILED_READ, ImageFailure, ThumbStore } from "./thumbStore";

const image = (n: number): GalleryImage => ({ path: `/tmp/${String(n)}.png`, caption: "", stamp: n });

/** A store whose loads the test answers, by path. */
function world(slots = 2) {
  const pending = new Map<string, { resolve: (url: string) => void; reject: (e: unknown) => void; signal: AbortSignal }>();
  const load = vi.fn(
    (i: GalleryImage, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        pending.set(i.path, { resolve, reject, signal });
      }),
  );
  const revoke = vi.fn();
  return { store: new ThumbStore(load, revoke, slots), load, revoke, pending };
}

const settled = async () => {
  await new Promise((r) => {
    setTimeout(r, 0);
  });
};

describe("ThumbStore", () => {
  it("loads at most its slots at once, in the order asked", async () => {
    const { store, load, pending } = world(2);
    for (const n of [1, 2, 3, 4]) store.hold(image(n));
    expect(load.mock.calls.map(([i]) => i.path)).toEqual(["/tmp/1.png", "/tmp/2.png"]);
    pending.get("/tmp/1.png")?.resolve("blob:1");
    await settled();
    expect(load.mock.calls.map(([i]) => i.path)).toEqual(["/tmp/1.png", "/tmp/2.png", "/tmp/3.png"]);
    expect(store.peek(imageKey(image(1)))).toEqual({ state: "ready", url: "blob:1" });
    expect(store.peek(imageKey(image(3)))).toEqual({ state: "loading" });
  });

  it("reads a file once for the grid and the filmstrip", async () => {
    const { store, load, pending } = world();
    const release = store.hold(image(1));
    store.hold(image(1));
    pending.get("/tmp/1.png")?.resolve("blob:1");
    await settled();
    release();
    store.hold(image(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops what scrolled away before it loaded, queued or running", async () => {
    const { store, load, pending } = world(1);
    const first = store.hold(image(1));
    const second = store.hold(image(2));
    store.hold(image(3));
    second();
    first();
    expect(pending.get("/tmp/1.png")?.signal.aborted).toBe(true);
    pending.get("/tmp/1.png")?.reject(new DOMException("aborted", "AbortError"));
    await settled();
    expect(load.mock.calls.map(([i]) => i.path)).toEqual(["/tmp/1.png", "/tmp/3.png"]);
  });

  it("loads again what comes back after it was dropped", async () => {
    const { store, load, pending } = world(1);
    store.hold(image(1))();
    pending.get("/tmp/1.png")?.reject(new DOMException("aborted", "AbortError"));
    await settled();
    store.hold(image(1));
    await settled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps a thumbnail no tile shows, for when it scrolls back", async () => {
    const { store, revoke, pending } = world();
    const release = store.hold(image(1));
    pending.get("/tmp/1.png")?.resolve("blob:1");
    await settled();
    release();
    expect(store.peek(imageKey(image(1)))).toEqual({ state: "ready", url: "blob:1" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("says a failure as given, and any other as a failed read", async () => {
    const { store, pending } = world();
    store.hold(image(1));
    store.hold(image(2));
    pending.get("/tmp/1.png")?.reject(new ImageFailure("Not found"));
    pending.get("/tmp/2.png")?.reject(new Error("permission denied at /private"));
    await settled();
    expect(store.peek(imageKey(image(1)))).toEqual({ state: "failed", reason: "Not found" });
    expect(store.peek(imageKey(image(2)))).toEqual({ state: "failed", reason: FAILED_READ });
  });

  it("tells only the tiles of the image that changed", async () => {
    const { store, pending } = world();
    const one = vi.fn();
    const two = vi.fn();
    store.subscribe(imageKey(image(1)), one);
    const stop = store.subscribe(imageKey(image(2)), two);
    store.hold(image(1));
    store.hold(image(2));
    stop();
    pending.get("/tmp/1.png")?.resolve("blob:1");
    pending.get("/tmp/2.png")?.resolve("blob:2");
    await settled();
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
  });

  it("frees every thumbnail on clear, and one that lands after it, and works again", async () => {
    const { store, load, revoke, pending } = world();
    store.hold(image(1));
    store.hold(image(2));
    pending.get("/tmp/1.png")?.resolve("blob:1");
    await settled();
    store.clear();
    expect(revoke.mock.calls).toEqual([["blob:1"]]);
    expect(pending.get("/tmp/2.png")?.signal.aborted).toBe(true);
    pending.get("/tmp/2.png")?.resolve("blob:late");
    await settled();
    expect(revoke.mock.calls).toEqual([["blob:1"], ["blob:late"]]);
    expect(store.peek(imageKey(image(1)))).toEqual({ state: "loading" });
    store.hold(image(1));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not mind a tile letting go after clear", () => {
    const { store } = world();
    const release = store.hold(image(1));
    store.clear();
    expect(release).not.toThrow();
  });
});
