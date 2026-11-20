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

const { clampFloat, enterFullscreen, escapeLeaves, promptEscapeLeaves, floatingTargetOf, floatingThreadOf, fullscreenOn, fullscreenPaneOf, leaveFullscreen, presentFullscreen, toggleFullscreen } = await import("./fullscreen");
const { presentShellCommand } = await import("./keyPresenters");
const { normalizeChord } = await import("@/keys/chord");

/** The command a chord of the key table runs (internal/command keybindings; the mock's list in vitest is not loaded here). */
const CHORDS: Record<string, string> = {
  "cmd+ctrl+h": "pane.focus.left",
  "cmd+ctrl+l": "pane.focus.right",
  "cmd+ctrl+arrowleft": "pane.focus.left",
  "cmd+ctrl+shift+h": "pane.move.left",
  "cmd+ctrl+shift+l": "pane.move.right",
  "cmd+ctrl+shift+arrowright": "pane.move.right",
  "cmd+shift+]": "tab.next",
};
const press = (chord: string) => presentShellCommand(CHORDS[normalizeChord(chord) ?? chord] ?? "");
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

  // No pane grid is mounted here: the rule is the layout's (docs/notes/shell-reset-rules.md).
  it.each([
    { name: "the window leaving its space", away: { current: "sp-b" } },
    { name: "the layout going (no space, no pane)", away: null },
  ])("ends on $name, and coming back does not resume it", async ({ away }) => {
    await seed("p-1");
    enterFullscreen();
    if (away) await seed("p-1", away);
    else resetLayout();
    expect(fs()).toBe("");
    await seed("p-1");
    expect(fullscreenOn()).toBe(false);
  });

  it("a layout change that keeps a pane to show keeps it", async () => {
    await seed("p-1");
    enterFullscreen();
    await seed("p-2", { active: "t-th" });
    expect(fs()).toBe("sp-a");
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
  it("pane.fullscreen toggles it", async () => {
    await seed("p-1");
    toggleFullscreen();
    expect(shown()).toBe("p-1");
    toggleFullscreen();
    expect(shown()).toBe("");
  });

  it("pane focus and move keys do nothing while it is on", async () => {
    await seed("p-2");
    // Off: the left key focuses p-1 (at once), then moving it right swaps it with p-2.
    press("cmd+ctrl+h");
    press("cmd+ctrl+shift+l");
    expect(ran.map(([n]) => n)).toEqual(["pane.focus.left", "pane.move.right"]);
    ran.length = 0;
    await seed("p-2");
    enterFullscreen();
    for (const chord of ["cmd+ctrl+h", "cmd+ctrl+l", "cmd+ctrl+arrowleft", "cmd+ctrl+shift+h", "cmd+ctrl+shift+arrowright"]) press(chord);
    expect(ran).toEqual([]);
    expect(shown()).toBe("p-2");
  });

  it("the pane's tab keys still switch its tabs", async () => {
    await seed("p-1");
    enterFullscreen();
    press("cmd+shift+]");
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

  // The prompt's editor marks every Escape handled: one typed there is decided before it (in capture).
  const PROMPT = '<div contenteditable="true" data-testid="composer-input" data-hit></div>';
  it("in a prompt with no use for it, leaves", () => {
    expect(promptEscapeLeaves(key({ target: inside(PROMPT) }))).toBe(true);
  });

  it.each([
    ["outside a prompt", () => key({ target: inside('<div><button data-hit></button></div>') })],
    ["another key", () => key({ key: "Enter", target: inside(PROMPT) })],
    ["with a modifier", () => key({ shiftKey: true, target: inside(PROMPT) })],
    ["composing", () => key({ isComposing: true, target: inside(PROMPT) })],
    ["taken before", () => key({ defaultPrevented: true, target: inside(PROMPT) })],
    ["a card open on it", () => key({ target: inside('<div contenteditable="true" data-testid="composer-input" aria-controls="list-1" data-hit></div>') })],
    ["the floating composer's prompt (Escape collapses it)", () => key({ target: inside(`<div data-testid="floating-composer">${PROMPT}</div>`) })],
  ])("in a prompt, stays: %s", (_name, e) => {
    expect(promptEscapeLeaves(e())).toBe(false);
  });

  it("in a prompt while dictating, stays (Escape stops the dictation)", async () => {
    const { useDictationStore } = await import("@/stores/dictation");
    useDictationStore.setState({ active: { clientId: "c-1", phase: "listening", sessionId: "d-1", startedAtMs: 1 } });
    try {
      expect(promptEscapeLeaves(key({ target: inside(PROMPT) }))).toBe(false);
    } finally {
      useDictationStore.setState({ active: null });
    }
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

describe("the floating composer's target", () => {
  // lead > child > grandchild; "solo" made by the user; "orphan" made by a removed thread; "c-a" and "c-b" made each other.
  const T = (id: string, createdBy = "") => ({ id, createdBy });
  const BY_ID = Object.fromEntries(
    [T("lead"), T("child", "lead"), T("grand", "child"), T("solo"), T("orphan", "gone"), T("c-a", "c-b"), T("c-b", "c-a"), T("other-lead"), T("loop-kid", "c-a")].map((t) => [t.id, t]),
  );
  const diff = (thread: string) => tab("t-d", "diff", thread);

  /** The current space "sp-a" with a pane holding the surface (active) and `tabs`; "sp-b" holding `elsewhere`. */
  async function layout(surface: string, tabs: ReturnType<typeof tab>[], elsewhere: ReturnType<typeof tab>[] = []): Promise<void> {
    const a = space(row("s-r", [pane("p-1", [diff(surface)], "t-d"), ...(tabs.length ? [pane("p-2", tabs)] : [])]), "p-1");
    const b = space(elsewhere.length ? row("s-r2", [pane("p-9", elsewhere)]) : null, elsewhere.length ? "p-9" : "", { id: "sp-b", name: "Other" });
    await seedLayout(layoutOf([a, b]));
  }

  it.each<[string, string, ReturnType<typeof tab>[], ReturnType<typeof tab>[], string]>([
    ["not a child", "solo", [], [], "solo"],
    ["not a child, its lead's tab open", "lead", [tab("t-l", "thread", "lead")], [], "lead"],
    ["a child, closed", "child", [tab("t-l", "thread", "lead")], [], "lead"],
    ["a child, closed, nothing open", "child", [], [], "lead"],
    ["a child open in this space", "child", [tab("t-l", "thread", "lead"), tab("t-c", "thread", "child")], [], "child"],
    ["a child open behind another tab", "child", [tab("t-c", "thread", "child"), tab("t-x", "prs")], [], "child"],
    ["a child open only in another space", "child", [], [tab("t-c", "thread", "child")], "lead"],
    ["a child's preview tab", "child", [tab("t-c", "thread", "child", { preview: true })], [], "child"],
    ["a child's other surface open (not its thread tab)", "child", [tab("t-f", "file", "child")], [], "lead"],
    ["a grandchild, none open", "grand", [], [], "lead"],
    ["a grandchild open", "grand", [tab("t-g", "thread", "grand"), tab("t-c", "thread", "child")], [], "grand"],
    ["a grandchild closed, its creator open", "grand", [tab("t-l", "thread", "lead"), tab("t-c", "thread", "child")], [], "child"],
    ["a grandchild closed, only the lead open", "grand", [tab("t-l", "thread", "lead")], [], "lead"],
    ["a thread whose creator is gone", "orphan", [], [], "orphan"],
    ["a creator cycle", "c-a", [tab("t-b", "thread", "c-b")], [], "c-a"],
    ["a child of a cycle", "loop-kid", [tab("t-b", "thread", "c-b")], [], "loop-kid"],
    ["a thread not in the list yet", "new", [], [], "new"],
  ])("%s", async (_, surface, tabs, elsewhere, want) => {
    await layout(surface, tabs, elsewhere);
    expect(floatingTargetOf(useLayoutStore.getState(), BY_ID, surface)).toBe(want);
  });

  it("no thread, no target", () => {
    expect(floatingTargetOf(useLayoutStore.getState(), BY_ID, "")).toBe("");
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
