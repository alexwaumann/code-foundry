import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewportReporter } from "./viewport";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function reporter(opts: { zoom?: number; fail?: boolean } = {}) {
  const sent: [number, number][] = [];
  const r = createViewportReporter({
    send: (w, h) => {
      sent.push([w, h]);
      return opts.fail ? Promise.reject(new Error("no daemon")) : Promise.resolve();
    },
    zoom: () => opts.zoom ?? 1,
    delayMs: 200,
  });
  return { r, sent };
}

describe("reporting the pane area's size", () => {
  it("sends one size once a burst of resizes holds still", async () => {
    const { r, sent } = reporter();
    r.report(1000, 700);
    await vi.advanceTimersByTimeAsync(100);
    r.report(1010, 700);
    await vi.advanceTimersByTimeAsync(100);
    r.report(1020, 700);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([[1020, 700]]);
  });

  it("sends layout px: the viewport's size divided by the page zoom", async () => {
    const { r, sent } = reporter({ zoom: 1.25 });
    r.report(1500, 1000);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([[1200, 800]]);
  });

  it("does not send the size it last sent again", async () => {
    const { r, sent } = reporter();
    r.report(1000, 700);
    await vi.advanceTimersByTimeAsync(200);
    r.report(900, 700);
    r.report(1000, 700);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([[1000, 700]]);
  });

  it("sends the last size again on resend (a daemon that restarted), and nothing before any report", async () => {
    const { r, sent } = reporter();
    r.resend();
    expect(sent).toEqual([]);
    r.report(1000, 700);
    await vi.advanceTimersByTimeAsync(200);
    r.resend();
    expect(sent).toEqual([
      [1000, 700],
      [1000, 700],
    ]);
  });

  it("tries a failed size again on the next report", async () => {
    const { r, sent } = reporter({ fail: true });
    r.report(1000, 700);
    await vi.advanceTimersByTimeAsync(200);
    r.report(1000, 700);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(2);
  });

  it("sends nothing for an empty box", async () => {
    const empty = reporter();
    empty.r.report(0, 700);
    await vi.advanceTimersByTimeAsync(200);
    expect(empty.sent).toEqual([]);
  });
});
