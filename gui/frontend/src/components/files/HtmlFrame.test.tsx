import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the frame handed its bridge host, per host (one per owning thread). */
const hosts = vi.hoisted(() => [] as { threadId: string | null; received: unknown[]; loads: number; disposed: boolean }[]);
vi.mock("@/stores/bridgeHost", () => ({
  createBridgeHost: (frame: { threadId: string | null }) => {
    const h = { threadId: frame.threadId, received: [] as unknown[], loads: 0, disposed: false };
    hosts.push(h);
    return {
      loaded: () => h.loads++,
      receive: (data: unknown) => h.received.push(data),
      dispose: () => (h.disposed = true),
    };
  },
}));
const { HTML_PREVIEW_SANDBOX, HtmlFrame, THREAD_PAGE_SANDBOX } = await import("./HtmlFrame");

const URL_ = "http://127.0.0.1:4100/preview/g1/page.html";
const PAGES = "http://127.0.0.1:4100";

beforeEach(() => {
  hosts.length = 0;
});
afterEach(cleanup);

function mount(thread: string | null, onResize?: (h: number) => void) {
  const view = render(<HtmlFrame url={URL_} name="page.html" thread={thread} onResize={onResize} testId="frame" />);
  const frame = () => screen.getByTestId<HTMLIFrameElement>("frame");
  const nonce = () => /#cf=([0-9a-f]+)$/.exec(frame().getAttribute("src") ?? "")?.[1] ?? "";
  const send = (data: unknown, opts: { origin?: string; source?: MessageEventSource | null } = {}) => {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: opts.origin ?? (thread === null ? "null" : PAGES), source: opts.source === undefined ? frame().contentWindow : opts.source }));
    });
  };
  return { view, frame, nonce, send };
}

describe("HtmlFrame", () => {
  it("opens a thread's page same-origin and any other page opaque, each with a nonce of its own", () => {
    const a = mount("t-1");
    expect(a.frame().getAttribute("sandbox")).toBe(THREAD_PAGE_SANDBOX);
    expect(THREAD_PAGE_SANDBOX).toContain("allow-same-origin");
    expect(a.frame().getAttribute("src")).toMatch(/#cf=[0-9a-f]{32}$/);
    const first = a.nonce();
    cleanup();
    const b = mount(null);
    expect(b.frame().getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
    expect(HTML_PREVIEW_SANDBOX).not.toContain("allow-same-origin");
    expect(b.nonce()).not.toBe(first);
  });

  it("hands its host only its own window's messages, at its origin, with its nonce", () => {
    const f = mount("t-1");
    const n = f.nonce();
    f.send({ cf: 1, type: "cf:hello", nonce: n });
    f.send({ cf: 1, type: "cf:hello" }); // no nonce: a page that navigated here
    f.send({ cf: 1, type: "cf:hello", nonce: "0".repeat(32) }); // another frame's
    f.send({ cf: 1, type: "cf:hello", nonce: n }, { origin: "https://example.com" }); // a site the frame navigated to
    f.send({ cf: 1, type: "cf:hello", nonce: n }, { origin: "null" });
    f.send({ cf: 1, type: "cf:hello", nonce: n }, { source: window }); // another window
    expect(hosts.at(-1)?.received).toEqual([{ cf: 1, type: "cf:hello", nonce: n }]);
  });

  it("takes a height from its own page with no nonce or its own, never another's or another origin's", () => {
    const heights: number[] = [];
    const f = mount("t-1", (h) => heights.push(h));
    f.send({ type: "cf:resize", height: 100 });
    f.send({ type: "cf:resize", height: 200, nonce: f.nonce() });
    f.send({ type: "cf:resize", height: 300, nonce: "x" });
    f.send({ type: "cf:resize", height: 400 }, { origin: "https://example.com" });
    expect(heights).toEqual([100, 200]);
    expect(hosts.at(-1)?.received).toEqual([]);
  });

  it("hears a page without a thread at the opaque origin only", () => {
    const heights: number[] = [];
    const f = mount(null, (h) => heights.push(h));
    f.send({ cf: 1, type: "cf:hello", nonce: f.nonce() });
    f.send({ cf: 1, type: "cf:hello", nonce: f.nonce() }, { origin: PAGES });
    f.send({ type: "cf:resize", height: 120 }, { origin: PAGES });
    f.send({ type: "cf:resize", height: 140 });
    expect(hosts.at(-1)?.received).toHaveLength(1);
    expect(heights).toEqual([140]);
  });

  it("reloads the frame, with the other sandbox, when its owning thread changes", () => {
    const f = mount(null);
    const before = f.frame();
    const nonce = f.nonce();
    f.view.rerender(<HtmlFrame url={URL_} name="page.html" thread="t-1" testId="frame" />);
    expect(f.frame()).not.toBe(before);
    expect(f.frame().getAttribute("sandbox")).toBe(THREAD_PAGE_SANDBOX);
    // The same frame, the same nonce; a new host for the new thread.
    expect(f.nonce()).toBe(nonce);
    expect(hosts.map((h) => [h.threadId, h.disposed])).toEqual([
      [null, true],
      ["t-1", false],
    ]);
  });
});
