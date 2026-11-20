import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageCheckTap } from "@/lib/pageCheck";

/** The check each bridge host was handed, and what the hosts received. */
const hosts = vi.hoisted(() => [] as { check: unknown; received: unknown[] }[]);
vi.mock("@/stores/bridgeHost", () => ({
  createBridgeHost: (frame: { check?: unknown }) => {
    const h = { check: frame.check, received: [] as unknown[] };
    hosts.push(h);
    return { loaded: () => {}, receive: (data: unknown) => h.received.push(data), dispose: () => {} };
  },
}));
vi.mock("@/lib/frameAttention", () => ({ watchFrameAttention: () => ({ present: () => false, stop: () => {} }) }));
vi.mock("@/stores/fileStamps", () => ({ fileWatcher: { watch: () => () => {}, check: () => {} } }));
const { HtmlFrame } = await import("./HtmlFrame");

const URL_ = "http://127.0.0.1:4100/preview/g1/page.html";
const PAGES = "http://127.0.0.1:4100";

/** A tap that records every call by name. */
function tap() {
  const calls: [string, unknown][] = [];
  const pings: ((seq: number) => void)[] = [];
  const rec =
    (name: string) =>
    (arg?: unknown): void => {
      calls.push([name, arg]);
    };
  const t: PageCheckTap = {
    loaded: rec("loaded"),
    note: rec("note"),
    resize: rec("resize"),
    problem: rec("problem"),
    busy: rec("busy"),
    call: rec("call"),
    stored: rec("stored"),
    attach: (ping) => {
      pings.push(ping);
      return () => {};
    },
  };
  return { t, calls, pings };
}

beforeEach(() => {
  hosts.length = 0;
});
afterEach(cleanup);

function mount(check?: PageCheckTap) {
  render(<HtmlFrame url={URL_} name="page.html" thread="t-1" check={check} testId="frame" />);
  const frame = () => screen.getByTestId<HTMLIFrameElement>("frame");
  const nonce = /[?&]cf-nonce=([0-9a-f]+)$/.exec(frame().getAttribute("src") ?? "")?.[1] ?? "";
  const send = (data: unknown) => {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: PAGES, source: frame().contentWindow }));
    });
  };
  return { frame, nonce, send };
}

// A page check (docs/notes/page-self-check.md) hears what the frame hears.
describe("HtmlFrame with a check", () => {
  it("taps the load, the document's answers, its errors, its height and what it could not do; and hands the bridge the check", () => {
    const c = tap();
    const f = mount(c.t);
    expect(hosts[0]?.check).toBe(c.t);
    fireEvent.load(f.frame());
    f.send({ type: "cf:here", seq: 1, files: [], theme: true, height: 312, loader: "running" });
    f.send({ type: "cf:loader", state: "ready" });
    f.send({ type: "cf:script-error", kind: "script", message: "ReferenceError: totl", where: "page.html:6:15" });
    f.send({ type: "cf:resize", height: 300, cf: f.nonce });
    f.send({ type: "cf:unsupported", what: "alert", text: "hi" });
    expect(c.calls).toEqual([
      ["loaded", undefined],
      ["note", { seq: 1, height: 312, loader: "running" }],
      ["note", { loader: "ready" }],
      ["problem", { kind: "script", call: "", code: "", message: "ReferenceError: totl", where: "page.html:6:15" }],
      ["resize", 300],
      ["problem", expect.objectContaining({ kind: "unsupported", call: "alert()" })],
    ]);
    // None of it reached the bridge: it carries no nonce.
    expect(hosts[0]?.received).toEqual([]);
  });

  it("hears a call the page's bridge refused itself, with the frame's nonce only, and keeps it from the bridge", () => {
    const c = tap();
    const f = mount(c.t);
    f.send({ type: "cf:refused", cf: 1, nonce: "other", call: "ui.notify", code: "gesture", message: "no click" });
    f.send({ type: "cf:refused", cf: 1, nonce: f.nonce, call: "ui.notify", code: "gesture", message: "no click" });
    expect(c.calls).toEqual([["problem", { kind: "bridge", call: "ui.notify", code: "gesture", message: "no click", where: "" }]]);
    expect(hosts[0]?.received).toEqual([]);
  });

  it("lets the check ping the document", () => {
    const c = tap();
    const f = mount(c.t);
    const post = vi.spyOn(f.frame().contentWindow as Window, "postMessage").mockImplementation(() => {});
    c.pings[0]?.(1_000_001);
    expect(post).toHaveBeenCalledWith({ type: "cf:ping", seq: 1_000_001 }, PAGES);
  });

  it("without a check, a script error goes nowhere", () => {
    const f = mount();
    expect(hosts[0]?.check).toBeUndefined();
    f.send({ type: "cf:script-error", kind: "script", message: "x", where: "" });
    expect(hosts[0]?.received).toEqual([]);
  });
});
