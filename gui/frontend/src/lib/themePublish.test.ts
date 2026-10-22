import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedTheme } from "@/api/ui";
import { useHealthStore } from "@/stores/health";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@/themes";
import { setThemePreference, setThemeSlots, startThemePublish, themeFrameMessage } from "./theme";

let stop: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  setThemePreference("dark");
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  setThemePreference("system");
  setThemeSlots({ light: DEFAULT_LIGHT, dark: DEFAULT_DARK });
  useHealthStore.setState({ status: "connecting", health: null, error: null });
});

/** A publisher that records what it was sent; `connect()` stands for the daemon being reached. */
function setup() {
  const sent: PublishedTheme[] = [];
  const publish = vi.fn((t: PublishedTheme) => {
    sent.push(t);
    return Promise.resolve();
  });
  let onConnect: () => void = () => {};
  stop = startThemePublish(publish, (cb) => {
    onConnect = cb;
    return () => {};
  });
  return {
    sent,
    publish,
    connect: () => {
      onConnect();
    },
  };
}

describe("startThemePublish", () => {
  it("publishes the active theme on start, debounced", () => {
    const { sent } = setup();
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe("github-dark");
    expect(sent[0]?.scheme).toBe("dark");
    expect(sent[0]?.vars["--cf-surface-raised"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("publishes once after a burst of theme changes, the last one", () => {
    const { sent } = setup();
    vi.advanceTimersByTime(150);
    setThemeSlots({ dark: "nord" });
    vi.advanceTimersByTime(50);
    setThemeSlots({ dark: "dracula" });
    vi.advanceTimersByTime(50);
    setThemePreference("light");
    vi.advanceTimersByTime(150);
    expect(sent.map((t) => t.id)).toEqual(["github-dark", "github-light"]);
  });

  it("does not publish a change that leaves the active theme the same", () => {
    const { sent } = setup();
    vi.advanceTimersByTime(150);
    setThemeSlots({ light: "rose-pine-dawn" }); // the dark slot is the active one
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
  });

  it("publishes again on every connect", () => {
    const { sent, connect } = setup();
    vi.advanceTimersByTime(150);
    connect();
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(2);
  });

  it("drops a failed publish and retries on the next connect", async () => {
    const publish = vi.fn(() => Promise.reject(new Error("daemon down")));
    let onConnect: () => void = () => {};
    stop = startThemePublish(publish, (cb) => {
      onConnect = cb;
      return () => {};
    });
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    onConnect();
    vi.advanceTimersByTime(150);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("stops publishing once stopped", () => {
    const { sent } = setup();
    stop();
    setThemeSlots({ dark: "nord" });
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(0);
  });

  it("connects through the health store: a first good ping and a new daemon pid", () => {
    const publish = vi.fn(() => Promise.resolve());
    stop = startThemePublish(publish);
    vi.advanceTimersByTime(150);
    expect(publish).toHaveBeenCalledTimes(1);
    useHealthStore.setState({ status: "ok", health: { pid: 10, version: "v", uptimeSeconds: 1 } });
    vi.advanceTimersByTime(150);
    useHealthStore.setState({ status: "ok", health: { pid: 10, version: "v", uptimeSeconds: 3 } }); // the same daemon
    vi.advanceTimersByTime(150);
    expect(publish).toHaveBeenCalledTimes(2);
    useHealthStore.setState({ status: "ok", health: { pid: 11, version: "v", uptimeSeconds: 0 } }); // restarted
    vi.advanceTimersByTime(150);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});

describe("themeFrameMessage", () => {
  it("is the active theme's id, scheme and slots", () => {
    const m = themeFrameMessage();
    expect(m.type).toBe("cf:theme");
    expect(m.id).toBe("github-dark");
    expect(m.scheme).toBe("dark");
    expect(Object.keys(m.vars).filter((k) => !/^--(cf|terminal|syn|sh)-/.test(k))).toEqual([]);
  });
});
