import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_STARTING } from "@/api/browser";

const api = vi.hoisted(() => ({ navigate: vi.fn(() => Promise.resolve("")), go: vi.fn(() => Promise.resolve()), reload: vi.fn(() => Promise.resolve()), relaunch: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) }));
vi.mock("@/api/browser", async (orig) => ({
  ...(await orig<typeof import("@/api/browser")>()),
  browserGo: api.go,
  navigateBrowser: api.navigate,
  reloadBrowser: api.reload,
  relaunchBrowser: api.relaunch,
  closeBrowser: api.close,
}));

const { browserAnswered, browserEnabled, browserInFront, browserLeft, closeBrowserSurface, openBrowserSurface, presentBrowserCommand, setBrowserState, takeBrowserAddress, useBrowserStore } = await import("./browser");
const { getPanel, allTabs, togglePanel, usePanelStore } = await import("./panel");
const { applySettingsSnapshot, useSettingsStore } = await import("./settings");
const { useUiStore } = await import("./ui");
const { showThreadView } = await import("./threadPanelIntent");
const { showView } = await import("./views");
const { useThreadsStore } = await import("./threads");
const { surfaceOf } = await import("@/surfaces/registry");
const { inPalette } = await import("@/keys/bindings");

const sel = { kind: "thread", id: "t1" } as const;
const key = "thread:t1";

function setting(on: boolean): void {
  applySettingsSnapshot({ values: { "experimental.chrome_surface": on ? "true" : "false" } } as unknown as Parameters<typeof applySettingsSnapshot>[0]);
}

const browserTabs = (k = key) => allTabs(getPanel(k)).filter((t) => t.kind === "browser");

beforeEach(() => {
  vi.clearAllMocks();
  usePanelStore.setState({ byKey: {} });
  useBrowserStore.setState({ states: {}, pending: {}, errors: {}, offline: {} });
  useUiStore.setState({ selection: sel });
  useThreadsStore.setState({ byId: { t1: { id: "t1" } as never } });
  setting(true);
});

afterEach(() => {
  useSettingsStore.setState({ snapshot: null });
});

describe("the setting", () => {
  it("reads as off with no snapshot, and with a daemon that does not know the key", () => {
    useSettingsStore.setState({ snapshot: null });
    expect(browserEnabled()).toBe(false);
    useSettingsStore.setState({ snapshot: { values: {} } as never });
    expect(browserEnabled()).toBe(false);
  });

  it("hides the surface and everything that opens it while off", () => {
    const spec = surfaceOf("browser");
    const ctx = { selection: sel, panelKey: key };
    expect(spec?.available(ctx)).toBe("enabled");
    setting(false);
    expect(spec?.available(ctx)).toBe("hidden");
    expect(spec?.openDefault(ctx)).toBeNull();
    expect(openBrowserSurface(sel, "https://example.com")).toBeNull();
    expect(showView("panel.browser", { url: "https://example.com" })).toBe(false);
    expect(showThreadView("panel.browser", "t1", { url: "https://example.com" })).toBeFalsy();
    expect(browserTabs()).toEqual([]);
    expect(useBrowserStore.getState().pending).toEqual({});
  });

  it("closes every Browser tab, in every panel, when it goes off", () => {
    openBrowserSurface(sel);
    openBrowserSurface({ kind: "thread", id: "t2" });
    expect(browserTabs()).toHaveLength(1);
    setting(false);
    expect(browserTabs()).toEqual([]);
    expect(browserTabs("thread:t2")).toEqual([]);
  });

  it("closes a tab a window restored while the setting is off", () => {
    openBrowserSurface(sel);
    useSettingsStore.setState({ snapshot: null });
    setting(false);
    expect(browserTabs()).toEqual([]);
  });
});

describe("opening", () => {
  it("opens one tab per panel and keeps the address for when it shows", () => {
    expect(openBrowserSurface(sel, "https://example.com/a")).toBe(key);
    expect(openBrowserSurface(sel, "https://example.com/b")).toBe(key);
    expect(browserTabs()).toHaveLength(1);
    expect(takeBrowserAddress(key)).toBe("https://example.com/b");
    expect(takeBrowserAddress(key)).toBe("");
  });

  it("goes at once on a surface that is showing, and to the same tab", () => {
    browserAnswered(key);
    openBrowserSurface(sel, "https://example.com/a");
    openBrowserSurface(sel, "https://example.com/b");
    expect(api.navigate.mock.calls).toEqual([
      [key, "https://example.com/a"],
      [key, "https://example.com/b"],
    ]);
    expect(useBrowserStore.getState().pending).toEqual({});
    expect(browserTabs()).toHaveLength(1);
    browserLeft(key);
  });

  it("waits again once the surface has left the screen", () => {
    browserAnswered(key);
    browserLeft(key);
    openBrowserSurface(sel, "https://example.com/a");
    expect(api.navigate).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().pending[key]).toBe("https://example.com/a");
  });

  it("sends an address that came while the stream connected, once it is answered", () => {
    openBrowserSurface(sel, "https://example.com/a");
    browserAnswered(key);
    browserAnswered(key);
    expect(api.navigate.mock.calls).toEqual([[key, "https://example.com/a"]]);
    expect(takeBrowserAddress(key)).toBe("");
    browserLeft(key);
  });

  it("the window's verb shows the panel, and a thread's verb leaves the selection alone", () => {
    expect(showView("panel.browser", { url: "https://example.com" })).toBe(true);
    expect(getPanel(key).open).toBe(true);
    useThreadsStore.setState({ byId: { t1: { id: "t1" } as never, t2: { id: "t2" } as never } });
    showThreadView("panel.browser", "t2", { url: "https://example.org" });
    expect(useUiStore.getState().selection).toEqual(sel);
    expect(browserTabs("thread:t2")).toHaveLength(1);
    expect(useBrowserStore.getState().pending["thread:t2"]).toBe("https://example.org");
  });
});

describe("the window's verbs", () => {
  const palette = (name: string) => inPalette({ name, noPalette: false, available: true, args: [] } as never);

  it("run on the tab in front, and only there", () => {
    expect(browserInFront()).toBe(false);
    expect(palette("browser.reload")).toBe(false);
    openBrowserSurface(sel);
    togglePanel(key, true);
    expect(browserInFront()).toBe(true);
    expect(palette("browser.reload")).toBe(true);
    presentBrowserCommand("browser.back");
    presentBrowserCommand("browser.forward");
    presentBrowserCommand("browser.reload");
    presentBrowserCommand("browser.relaunch");
    expect(api.go.mock.calls).toEqual([
      [key, -1],
      [key, 1],
    ]);
    expect(api.reload).toHaveBeenCalledWith(key);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("are handled with no tab, and do nothing", () => {
    expect(presentBrowserCommand("browser.reload")).toBe(true);
    expect(api.reload).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("closes the page and forgets its state", () => {
    setBrowserState(key, BROWSER_STARTING);
    closeBrowserSurface(key);
    expect(api.close).toHaveBeenCalledWith(key);
    expect(useBrowserStore.getState().states[key]).toBeUndefined();
  });

  it("is the tab's beforeClose", () => {
    const tab = { id: "browser", kind: "browser", title: "Browser", params: {} };
    expect(surfaceOf("browser")?.beforeClose?.(key, tab)).toBe(true);
    expect(api.close).toHaveBeenCalledWith(key);
  });
});
