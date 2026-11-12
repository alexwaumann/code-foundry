import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

const ran: [string, Record<string, string>][] = [];
const focusedPanes: string[] = [];
const focusedTabs: string[] = [];
vi.mock("@/shell/commands", () => ({
  focusPaneNow: (id: string) => {
    focusedPanes.push(id);
    return Promise.resolve(true);
  },
  focusTabNow: (id: string) => {
    focusedTabs.push(id);
    return Promise.resolve(true);
  },
  runLayoutCommand: (name: string, args: Record<string, string>) => {
    ran.push([name, args]);
    return Promise.resolve({ rev: 2 });
  },
  afterRev: () => Promise.resolve(),
  closeTabNow: () => Promise.resolve(null),
}));

const { clampFloat, enterFullscreen, escapeLeaves, floatingThreadOf, fullscreenOn, fullscreenPaneOf, leaveFullscreen, presentFullscreen, toggleFullscreen } = await import("./fullscreen");
const { shellKeyFor } = await import("./keys");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");
const { plainRects } = await import("./geometry/rects");
const { geoTree } = await import("@/stores/layout");
const { resetShellView, setShellFrame, useShellViewStore } = await import("@/stores/shellView");

const TREE = row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-d", "diff", "s-1")], "t-d"), pane("p-2", [tab("t-prs", "prs")])]);

async function seed(focus: string, opts: { active?: string; current?: string } = {}): Promise<void> {
  const tree = opts.active ? row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-d", "diff", "s-1")], opts.active), pane("p-2", [tab("t-prs", "prs")])]) : TREE;
  const l = layoutOf([space(tree, focus), space(null, "", { id: "sp-b", name: "Other" })]);
  await seedLayout({ ...l, currentSpaceId: opts.current ?? "sp-a" });
  const s = useLayoutStore.getState();
  setShellFrame(plainRects(geoTree(s, "sp-a"), 1200, 800));
}

const fs = () => useShellViewStore.getState().fullscreen;
const shown = () => fullscreenPaneOf(useLayoutStore.getState(), fs());

beforeEach(() => {
  ran.length = 0;
  focusedPanes.length = 0;
  focusedTabs.length = 0;
  resetLayout();
  resetShellView();
});

afterEach(() => {
  resetLayout();
  resetShellView();
});

describe("full screen state", () => {
  it("shows the focused pane, and nothing when off", async () => {
    await seed("p-2");
    expect(shown()).toBe("");
    enterFullscreen();
    expect([fs(), shown(), fullscreenOn()]).toEqual(["sp-a", "p-2", true]);
    leaveFullscreen();
    expect([fs(), shown(), fullscreenOn()]).toEqual(["", "", false]);
  });

  it("entering for another pane focuses it first", async () => {
    await seed("p-2");
    enterFullscreen("p-1");
    expect(focusedPanes).toEqual(["p-1"]);
    expect(fs()).toBe("sp-a");
  });

  it("the same key toggles it", async () => {
    await seed("p-1");
    toggleFullscreen();
    expect(shown()).toBe("p-1");
    toggleFullscreen();
    expect(shown()).toBe("");
  });

  it("switching tabs in the pane keeps it; the focus moving to another pane takes it there", async () => {
    await seed("p-1");
    enterFullscreen();
    await seed("p-1", { active: "t-th" });
    expect(shown()).toBe("p-1");
    await seed("p-2");
    expect(shown()).toBe("p-2");
  });

  it("is off in another space, and with no pane to show", async () => {
    await seed("p-1");
    enterFullscreen();
    await seed("p-1", { current: "sp-b" });
    expect(shown()).toBe("");
    expect(fullscreenOn()).toBe(false);
    expect(fullscreenPaneOf({ currentSpaceId: "sp-a", spaces: { "sp-a": { id: "sp-a", name: "", focus: "", mru: [], drafts: [] } }, panes: {} }, "sp-a")).toBe("");
  });

  it("turning it off or on again puts the floating composer back at its spot, collapsed", async () => {
    await seed("p-1");
    enterFullscreen();
    useShellViewStore.setState({ floating: { expanded: true, x: 40, y: -120 } });
    leaveFullscreen();
    enterFullscreen();
    expect(useShellViewStore.getState().floating).toEqual({ expanded: false, x: 0, y: 0 });
  });

  it("pane.fullscreen's params: on, off, toggle, and a pane", async () => {
    await seed("p-1");
    presentFullscreen({ mode: "on" });
    expect(shown()).toBe("p-1");
    presentFullscreen({ mode: "on" });
    expect(shown()).toBe("p-1");
    presentFullscreen({ mode: "off" });
    expect(shown()).toBe("");
    presentFullscreen({ mode: "toggle", pane: "p-2" });
    expect(focusedPanes).toEqual(["p-2"]);
    expect(fs()).toBe("sp-a");
  });
});

describe("keys in full screen", () => {
  it("cmd+shift+enter toggles it", async () => {
    await seed("p-1");
    shellKeyFor("cmd+shift+enter")?.run();
    expect(shown()).toBe("p-1");
    shellKeyFor("cmd+shift+enter")?.run();
    expect(shown()).toBe("");
  });

  it("pane focus and move keys do nothing while it is on", async () => {
    await seed("p-2");
    // Off: the left key focuses p-1 (at once), then moving it right swaps it with p-2.
    shellKeyFor("cmd+ctrl+h")?.run();
    shellKeyFor("cmd+ctrl+shift+l")?.run();
    expect(ran.map(([n]) => n)).toEqual(["pane.focus.left", "pane.move.right"]);
    ran.length = 0;
    await seed("p-2");
    enterFullscreen();
    for (const chord of ["cmd+ctrl+h", "cmd+ctrl+l", "cmd+ctrl+arrowleft", "cmd+ctrl+shift+h", "cmd+ctrl+shift+arrowright"]) shellKeyFor(chord)?.run();
    expect(ran).toEqual([]);
    expect(shown()).toBe("p-2");
  });

  it("the pane's tab keys still switch its tabs", async () => {
    await seed("p-1");
    enterFullscreen();
    shellKeyFor("cmd+shift+]")?.run();
    expect(focusedTabs).toEqual(["t-th"]);
  });
});

describe("Escape", () => {
  const key = (o: Partial<KeyboardEvent> & { target?: EventTarget | null } = {}) =>
    ({ key: "Escape", defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: document.body, ...o }) as KeyboardEvent;
  const inside = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    return host.querySelector("[data-hit]") ?? host;
  };

  it("leaves when nothing took it", () => {
    expect(escapeLeaves(key())).toBe(true);
    expect(escapeLeaves(key({ target: inside('<div><button data-hit></button></div>') }))).toBe(true);
    // A list on the page, as a diff's file list.
    expect(escapeLeaves(key({ target: inside('<div role="listbox" tabindex="0" data-hit></div>') }))).toBe(true);
  });

  it.each([
    ["another key", key({ key: "Enter" })],
    ["taken before", key({ defaultPrevented: true })],
    ["with a modifier", key({ shiftKey: true })],
    ["typed in a terminal", key({ target: inside('<div data-terminal-host><textarea data-hit></textarea></div>') })],
    ["in a menu", key({ target: inside('<div role="menu"><div role="menuitem" data-hit></div></div>') })],
    ["in a dialog", key({ target: inside('<div role="dialog"><input data-hit /></div>') })],
    ["a popover that closed with it", key({ target: document.createElement("button") })],
  ])("stays: %s", (_name, e) => {
    expect(escapeLeaves(e)).toBe(false);
  });
});

describe("the floating composer's thread", () => {
  it.each([
    [tab("t-d", "diff", "s-1"), "s-1"],
    [tab("t-f", "file", "s-1"), "s-1"],
    [tab("t-term", "terminal", "s-1"), "s-1"],
    [tab("t-th", "thread", "s-1"), ""],
    [tab("t-c", "compose"), ""],
    [tab("t-prs", "prs"), ""],
    [tab("t-free", "terminal"), ""],
  ])("%j floats %j", (t, want) => {
    expect(floatingThreadOf(t)).toBe(want);
  });

  it("no tab floats nothing", () => {
    expect(floatingThreadOf(undefined)).toBe("");
  });
});

describe("clampFloat", () => {
  const spot = { x: 300, y: 700, w: 400, h: 80 };
  const area = { w: 1000, h: 800 };
  it("keeps a drag inside the pane", () => {
    expect(clampFloat({ x: 0, y: 0 }, spot, area)).toEqual({ x: 0, y: 0 });
    expect(clampFloat({ x: -50, y: -300 }, spot, area)).toEqual({ x: -50, y: -300 });
    expect(clampFloat({ x: -900, y: -900 }, spot, area)).toEqual({ x: 12 - 300, y: 12 - 700 });
    expect(clampFloat({ x: 900, y: 900 }, spot, area)).toEqual({ x: 1000 - 12 - 700, y: 800 - 12 - 780 });
  });
});
