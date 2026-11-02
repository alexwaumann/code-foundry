// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two daemons' windows share WebKit's localStorage: the key names the daemon's address.
const endpoint = vi.hoisted(() => ({ baseUrl: "http://127.0.0.1:7001" }));
vi.mock("@/api/endpoint", () => ({ daemon: { resolveEndpoint: () => Promise.resolve({ baseUrl: endpoint.baseUrl, token: "t" }) } }));

const { WINDOW_ID, isActingWindow, markWindowFocused, startWindowFocus } = await import("./windowFocus");
const { showView } = await import("./views");
const movePicker = await import("./movePicker");

const KEY = "cf.window.lastFocused http://127.0.0.1:7001";
let focused = false;

beforeEach(() => {
  localStorage.clear();
  endpoint.baseUrl = "http://127.0.0.1:7001";
  focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isActingWindow: the focused window, else the last focused", () => {
  it.each<[string, boolean, string | null, boolean]>([
    ["focused", true, "another", true],
    ["not focused, focused last", false, WINDOW_ID, true],
    ["not focused, another window focused last", false, "another", false],
    ["no window has recorded a focus", false, null, true],
  ])("%s", async (_, isFocused, last, want) => {
    focused = isFocused;
    if (last !== null) localStorage.setItem(KEY, last);
    expect(await isActingWindow()).toBe(want);
  });

  it("another daemon's last focused window does not count", async () => {
    localStorage.setItem("cf.window.lastFocused http://127.0.0.1:7002", "another");
    expect(await isActingWindow()).toBe(true);
  });

  it("taking the focus records this window; closing it while last forgets it", async () => {
    const stop = startWindowFocus();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      expect(localStorage.getItem(KEY)).toBe(WINDOW_ID);
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(KEY)).toBeNull();
    // Another window focused since: closing this one leaves its record.
    await markWindowFocused();
    localStorage.setItem(KEY, "another");
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(KEY)).toBe("another");
    stop();
  });
});

describe("ShowView thread.move (thread.move.open from the CLI)", () => {
  it.each<[string, string | null, number]>([
    ["opens the picker in the last focused window", WINDOW_ID, 1],
    ["leaves it to the window focused since", "another", 0],
  ])("%s", async (_, last, calls) => {
    const open = vi.spyOn(movePicker, "openMovePicker").mockReturnValue(true);
    if (last !== null) localStorage.setItem(KEY, last);
    expect(showView("thread.move", { id: "s-1" })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(open.mock.calls).toEqual(calls ? [["s-1"]] : []);
  });
});
