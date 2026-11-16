import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));

const { fakeDictation, dictationSnap } = await import("@/test/dictation");
const { holdDictation, presentDictationHold, registerDictationTarget, resetDictationForTests, useDictationStore } = await import("./dictation");
const uiStore = await import("./ui");
const shell = await import("@/test/shellLayout");
const { resetLayout } = await import("./layout");

/** A composer mounted in the page. */
function composer(clientId: string, primary = true) {
  const root = document.createElement("div");
  const input = document.createElement("input");
  root.append(input);
  document.body.append(root);
  const inserted: string[] = [];
  const unregister = registerDictationTarget({ clientId, primary, root: () => root, insert: (t) => inserted.push(t) });
  return { input, inserted, unregister };
}

async function hold(snap = dictationSnap()) {
  fakeDictation.publish(snap);
  release = holdDictation();
  await vi.waitFor(() => {
    expect(useDictationStore.getState().snapshot).toBe(snap);
  });
}

let release: () => void = () => undefined;

const active = () => useDictationStore.getState().active;

async function listening() {
  await vi.waitFor(() => {
    expect(active()?.phase).toBe("listening");
  });
}

async function idle() {
  await vi.waitFor(() => {
    expect(active()).toBeNull();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  release();
  resetDictationForTests();
  fakeDictation.reset();
});

describe("dictation.hold", () => {
  it("press starts the composer dictation.toggle would pick, and release ends it with its last phrase", async () => {
    await hold();
    const c = composer("c1");
    expect(presentDictationHold("press")).toBe(true);
    await listening();
    expect(fakeDictation.calls).toContain("start c1");
    fakeDictation.setFlushPhrase("the end");
    presentDictationHold("release");
    await idle();
    expect(fakeDictation.calls).toContain("stop dict-1 true tail");
    await vi.waitFor(() => {
      expect(c.inserted).toEqual(["the end"]);
    });
  });

  it("discard ends it without", async () => {
    await hold();
    const c = composer("c1");
    presentDictationHold("press");
    await listening();
    fakeDictation.setFlushPhrase("dropped");
    presentDictationHold("discard");
    await idle();
    expect(fakeDictation.calls).toContain("stop dict-1 false");
    expect(c.inserted).toEqual([]);
  });

  it("prefers the composer with the keyboard over the content pane's", async () => {
    await hold();
    composer("primary");
    const side = composer("side", false);
    side.input.focus();
    presentDictationHold("press");
    await listening();
    expect(fakeDictation.calls).toContain("start side");
  });

  it("press with no composer does nothing, and says so", async () => {
    await hold();
    expect(presentDictationHold("press")).toBe(false);
    expect(active()).toBeNull();
    expect(fakeDictation.calls.filter((c) => c.startsWith("start"))).toEqual([]);
  });

  it("press with dictation unavailable does nothing", async () => {
    await hold(dictationSnap({ state: "noModel", model: { downloaded: false } }));
    composer("c1");
    expect(presentDictationHold("press")).toBe(false);
  });

  it("press while that composer already listens keeps its session, and release ends it", async () => {
    await hold();
    composer("c1");
    presentDictationHold("press");
    await listening();
    const id = active()?.sessionId;
    presentDictationHold("press");
    expect(active()?.sessionId).toBe(id);
    expect(fakeDictation.calls.filter((c) => c.startsWith("start"))).toEqual(["start c1"]);
    presentDictationHold("release");
    await idle();
  });

  it("press during that composer's tail cuts it and starts again", async () => {
    await hold();
    const c = composer("c1");
    fakeDictation.holdTails();
    presentDictationHold("press");
    await listening();
    fakeDictation.setFlushPhrase("the end");
    presentDictationHold("release");
    await vi.waitFor(() => {
      expect(active()?.phase).toBe("stopping");
    });
    expect(c.inserted).toEqual([]);
    presentDictationHold("press");
    await vi.waitFor(() => {
      expect(active()?.sessionId).toBe("dict-2");
    });
    expect(fakeDictation.calls).toEqual(["start c1", "stop dict-1 true tail", "stop dict-1 true", "start c1"]);
    expect(c.inserted).toEqual(["the end"]);
  });

  it("a release before Start answered gives the session up", async () => {
    await hold();
    composer("c1");
    const answer = fakeDictation.holdStart();
    presentDictationHold("press");
    await vi.waitFor(() => {
      expect(active()?.phase).toBe("starting");
    });
    presentDictationHold("discard");
    answer();
    await idle();
    await vi.waitFor(() => {
      expect(fakeDictation.calls).toContain("stop dict-1 false");
    });
  });

  it("a release while the press still waits on another session's stop leaves nothing listening", async () => {
    const snap = dictationSnap({ state: "listening", session: { id: "cli-1", clientId: "cli", startedAtMs: 1, stopping: false } });
    await hold(snap);
    composer("c1");
    presentDictationHold("press");
    presentDictationHold("discard");
    await vi.waitFor(() => {
      expect(fakeDictation.calls.some((c) => c.startsWith("start c1"))).toBe(true);
    });
    await idle();
    await vi.waitFor(() => {
      expect(fakeDictation.calls).toContain("stop dict-1 false");
    });
  });

  it("release with nothing open does nothing", async () => {
    await hold();
    expect(presentDictationHold("release")).toBe(true);
    await Promise.resolve();
    expect(fakeDictation.calls.filter((c) => c.startsWith("stop"))).toEqual([]);
  });
});

describe("the composer target", () => {
  const reports = () => fakeDictation.composerReports;

  it("tells the daemon when a composer comes and goes", async () => {
    await hold();
    const c = composer("c1");
    expect(reports()).toEqual([true]);
    c.unregister();
    expect(reports()).toEqual([true, false]);
  });

  it("says nothing while dictation is off", async () => {
    await hold(dictationSnap({ enabled: false, state: "disabled" }));
    composer("c1");
    expect(reports()).toEqual([]);
  });

  it("says nothing when the daemon already knows", async () => {
    composer("c1");
    await hold(dictationSnap({ composerTarget: true }));
    expect(reports()).toEqual([]);
  });

  it("tells a daemon that forgot, from its snapshot", async () => {
    composer("c1");
    await hold(dictationSnap({ composerTarget: true }));
    const fresh = dictationSnap({ composerTarget: false });
    fakeDictation.publish(fresh);
    await vi.waitFor(() => {
      expect(useDictationStore.getState().snapshot).toBe(fresh);
    });
    expect(reports()).toEqual([true]);
  });

  it("a composer that is not the content pane's counts while it has the keyboard", async () => {
    await hold();
    const side = composer("side", false);
    expect(reports()).toEqual([]);
    side.input.focus();
    await vi.waitFor(() => {
      expect(reports()).toEqual([true]);
    });
    side.input.blur();
    await vi.waitFor(() => {
      expect(reports()).toEqual([true, false]);
    });
  });

  it("a text field outside every composer takes the words: no composer while it has the keyboard", async () => {
    await hold();
    composer("c1");
    expect(reports()).toEqual([true]);
    const note = document.createElement("textarea");
    document.body.append(note);
    note.focus();
    await vi.waitFor(() => {
      expect(reports()).toEqual([true, false]);
    });
    // Not a composer, but a field: the host pastes into it.
    expect(fakeDictation.fieldReports).toEqual([false, true]);
    // The host's press is not the composer's: it pastes into the field instead.
    expect(presentDictationHold("press")).toBe(false);
    expect(active()).toBeNull();
    note.blur();
    await vi.waitFor(() => {
      expect(reports()).toEqual([true, false, true]);
    });
    expect(presentDictationHold("press")).toBe(true);
  });

  it("a button with the keyboard changes nothing: the selected composer takes it", async () => {
    await hold();
    composer("c1");
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    expect(presentDictationHold("press")).toBe(true);
    await listening();
    expect(fakeDictation.calls).toContain("start c1");
  });

describe("where dictation goes from what has the keyboard", () => {
  const { useUiStore } = uiStore;
  const { layoutOf, pane, row, seedLayout, space, tab } = shell;

  /** A pane of the grid in the page. */
  function paneEl(id: string): HTMLElement {
    const el = document.createElement("div");
    el.dataset.paneId = id;
    document.body.append(el);
    return el;
  }

  /** A thread's composer in a pane, as ThreadComposer registers it. */
  function threadComposer(thread: string, into: HTMLElement) {
    const root = document.createElement("div");
    into.append(root);
    return registerDictationTarget({ clientId: `c-${thread}`, primary: true, threadId: thread, root: () => root, insert: () => undefined });
  }

  /** A terminal in `into` with the keyboard (xterm's hidden textarea). */
  function focusTerminal(into: HTMLElement): void {
    const term = document.createElement("div");
    term.className = "xterm";
    const input = document.createElement("textarea");
    term.append(input);
    into.append(term);
    input.focus();
  }

  /** s-1's thread, s-2's thread, a terminal tab (linked to `linked`, or to nothing), in a row. */
  async function seed(linked: string): Promise<void> {
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", [tab("t-1", "thread", "s-1")]), pane("p-2", [tab("t-2", "thread", "s-2")]), pane("p-3", [tab("t-term", "terminal", linked)])]), "p-1")]));
  }

  const pressed = () => {
    const ok = presentDictationHold("press");
    return ok ? fakeDictation.calls.at(-1) : "nowhere";
  };

  beforeEach(() => {
    resetLayout();
    useUiStore.setState({ selection: { kind: "none" } });
  });

  it("a terminal linked to a thread: that thread's composer, while it is on screen", async () => {
    await hold();
    await seed("s-2");
    threadComposer("s-1", paneEl("p-1"));
    const second = threadComposer("s-2", paneEl("p-2"));
    focusTerminal(paneEl("p-3"));
    expect(pressed()).toBe("start c-s-2");
    presentDictationHold("discard");
    await idle();
    // Its thread is no longer the selected tab of a pane: its composer is not mounted.
    second();
    expect(pressed()).toBe("nowhere");
  });

  it("a terminal linked to no thread: nowhere, and the host is told so", async () => {
    await hold();
    await seed("");
    // The selected thread's composer takes a hold until the keyboard goes into the terminal.
    useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
    threadComposer("s-1", paneEl("p-1"));
    expect(fakeDictation.composerReports).toEqual([true]);
    focusTerminal(paneEl("p-3"));
    expect(pressed()).toBe("nowhere");
    await vi.waitFor(() => {
      expect([fakeDictation.composerReports, fakeDictation.fieldReports]).toEqual([
        [true, false],
        [false, false],
      ]);
    });
  });

  it("a thread's quick terminal, under its conversation: that pane's composer", async () => {
    await hold();
    await seed("");
    const p1 = paneEl("p-1");
    threadComposer("s-1", p1);
    threadComposer("s-2", paneEl("p-2"));
    focusTerminal(p1);
    expect(pressed()).toBe("start c-s-1");
  });

  it("the keyboard on nothing in particular: the selected thread's composer, else nowhere", async () => {
    await hold();
    await seed("");
    threadComposer("s-1", paneEl("p-1"));
    threadComposer("s-2", paneEl("p-2"));
    expect(pressed()).toBe("nowhere");
    useUiStore.setState({ selection: { kind: "thread", id: "s-2" } });
    expect(pressed()).toBe("start c-s-2");
    presentDictationHold("discard");
    await idle();
    // Selected, but not on screen.
    useUiStore.setState({ selection: { kind: "thread", id: "s-9" } });
    expect(pressed()).toBe("nowhere");
  });
});
});
