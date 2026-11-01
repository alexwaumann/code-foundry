/**
 * A faked PluginService for surface component tests: WatchSurface as a stream the test
 * pushes updates into (what the mock's plugin host sends in e2e), and Act recorded (the
 * mock's GET /__mock/plugin/acts). Imports no store and no mocked module, so vi.mock
 * factories may import it:
 *
 *   vi.mock("@/api/plugin", async (orig) => ({ ...(await orig<typeof import("@/api/plugin")>()), ...(await import("@/test/pluginSurfaceFakes")).surfaceFakes }));
 */
import type { ActRequestView, SurfaceRefView, SurfaceUpdateView } from "@/api/plugin";

interface Stream {
  ref: SurfaceRefView;
  queue: SurfaceUpdateView[];
  wake: (() => void) | null;
}

export const surfaces = {
  streams: [] as Stream[],
  acts: [] as ActRequestView[],
  /** The next Act's answer: the version it took, or a refusal (thrown). */
  answer: ((req: ActRequestView) => Promise.resolve(req.version)) as (req: ActRequestView) => Promise<number>,
};

export function resetSurfaces(): void {
  surfaces.streams.length = 0;
  surfaces.acts.length = 0;
  surfaces.answer = (req) => Promise.resolve(req.version);
}

/** Sends updates down every open stream of `surface` (all of them when omitted). */
export function push(updates: SurfaceUpdateView[], surface?: string): void {
  for (const s of surfaces.streams) {
    if (surface && s.ref.surface !== surface) continue;
    s.queue.push(...updates);
    s.wake?.();
  }
}

export const surfaceFakes = {
  watchSurface: async function* (ref: SurfaceRefView, signal: AbortSignal): AsyncGenerator<SurfaceUpdateView> {
    const s: Stream = { ref, queue: [], wake: null };
    surfaces.streams.push(s);
    try {
      while (!signal.aborted) {
        const next = s.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          s.wake = resolve;
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
        s.wake = null;
      }
    } finally {
      surfaces.streams.splice(surfaces.streams.indexOf(s), 1);
    }
  },
  actOnSurface: (req: ActRequestView): Promise<number> => {
    surfaces.acts.push(req);
    return surfaces.answer(req);
  },
};
