import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
/** Whether the user is in the frame (lib/frameAttention), and the links it sent to the browser. */
const user = vi.hoisted(() => ({ present: true, opened: [] as string[] }));
vi.mock("@/lib/frameAttention", () => ({ watchFrameAttention: () => ({ present: () => user.present, stop: () => {} }) }));
vi.mock("@/stores/gh", () => ({
  openUrl: (url: string) => {
    user.opened.push(url);
    return Promise.resolve();
  },
}));
const { FRAME_REVEAL_MS, HTML_PREVIEW_SANDBOX, HtmlFrame, OPEN_GAP_MS, THREAD_PAGE_SANDBOX } = await import("./HtmlFrame");

const URL_ = "http://127.0.0.1:4100/preview/g1/page.html";
const PAGES = "http://127.0.0.1:4100";

beforeEach(() => {
  hosts.length = 0;
  user.present = true;
  user.opened.length = 0;
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
  it("undoes the page zoom on the frame, and reports a page's height in layout px", () => {
    document.documentElement.style.setProperty("--cf-zoom", "0.9");
    try {
      const heights: number[] = [];
      const f = mount("t-1", (h) => heights.push(h));
      expect(f.frame().className).toContain("[zoom:calc(1/var(--cf-zoom))]");
      f.send({ type: "cf:resize", height: 270 });
      expect(heights).toEqual([300]);
    } finally {
      document.documentElement.style.removeProperty("--cf-zoom");
    }
  });

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

  it("opens a link its page sent in the browser: no nonce needed, only while the user is in the frame, one per OPEN_GAP_MS", () => {
    vi.useFakeTimers();
    try {
      const f = mount("t-1");
      f.send({ type: "cf:open", url: "https://github.com/acme/app" });
      f.send({ type: "cf:open", url: "https://github.com/acme/second" }); // too soon after
      vi.advanceTimersByTime(OPEN_GAP_MS);
      f.send({ type: "cf:open", url: "javascript:alert(1)" });
      f.send({ type: "cf:open", url: "https://example.com/evil" }, { origin: "https://example.com" }); // a site the frame went to
      user.present = false;
      f.send({ type: "cf:open", url: "https://example.com/unasked" });
      user.present = true;
      f.send({ type: "cf:open", url: "https://example.com/later" });
      expect(user.opened).toEqual(["https://github.com/acme/app", "https://example.com/later"]);
      expect(hosts.at(-1)?.received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists what the frame could not do for the page with its errors, an opaque page's too", () => {
    const seen: { call: string; code: string; count: number }[][] = [];
    render(<HtmlFrame url={URL_} name="page.html" thread={null} onPageErrors={(list) => seen.push(list.map(({ call, code, count }) => ({ call, code, count })))} testId="frame" />);
    const win = screen.getByTestId<HTMLIFrameElement>("frame").contentWindow;
    const send = (data: unknown) => {
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: win }));
      });
    };
    send({ type: "cf:unsupported", what: "confirm", text: "Delete it?" });
    send({ type: "cf:unsupported", what: "confirm", text: "Delete it?" });
    send({ type: "cf:unsupported", what: "download", text: "rows.csv" });
    send({ type: "cf:unsupported", what: "nothing" });
    expect(seen.at(-1)).toEqual([
      { call: "confirm()", code: "unavailable", count: 2 },
      { call: "download", code: "unavailable", count: 1 },
    ]);
  });

  it("asks for a thread's page painted in the theme (cf-page=1) and any other page as written", () => {
    const a = mount("t-1");
    expect(a.frame().getAttribute("src")).toMatch(/^http:\/\/127\.0\.0\.1:4100\/preview\/g1\/page\.html\?cf-page=1#cf=[0-9a-f]{32}$/);
    cleanup();
    const b = mount(null);
    expect(b.frame().getAttribute("src")).toMatch(/^http:\/\/127\.0\.0\.1:4100\/preview\/g1\/page\.html#cf=[0-9a-f]{32}$/);
  });

  it("hides the frame over the surface until it loads, then shows it; white only for an opaque frame", () => {
    for (const thread of ["t-1", null]) {
      const f = mount(thread);
      expect(screen.getByTestId("frame-box").className).toContain("bg-cf-surface");
      expect(f.frame().className).toContain("opacity-0");
      expect(f.frame().className).not.toContain("bg-white");
      expect(f.frame().dataset.shown).toBeUndefined();
      expect(screen.getByTestId("frame-loading")).toBeTruthy();
      fireEvent.load(f.frame());
      expect(f.frame().className).toContain("opacity-100");
      expect(f.frame().className).toContain("motion-reduce:transition-none");
      expect(f.frame().dataset.shown).toBe("true");
      expect(screen.queryByTestId("frame-loading")).toBeNull();
      expect(f.frame().className.includes("bg-white")).toBe(thread === null);
      cleanup();
    }
  });

  it("shows a frame whose load never comes after FRAME_REVEAL_MS", () => {
    vi.useFakeTimers();
    try {
      const f = mount("t-1");
      act(() => {
        vi.advanceTimersByTime(FRAME_REVEAL_MS - 1);
      });
      expect(f.frame().dataset.shown).toBeUndefined();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(f.frame().dataset.shown).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the frame again when it reloads for a new owning thread", () => {
    const f = mount(null);
    fireEvent.load(f.frame());
    expect(f.frame().dataset.shown).toBe("true");
    f.view.rerender(<HtmlFrame url={URL_} name="page.html" thread="t-1" testId="frame" />);
    expect(f.frame().dataset.shown).toBeUndefined();
    fireEvent.load(f.frame());
    expect(f.frame().dataset.shown).toBe("true");
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
