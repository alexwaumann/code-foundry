import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "@/api/terminal";
import { closeTerminalFind, noteTerminalKeyboard, openTerminalFind, presentTerminalFind, registerTerminalFindHost, setTerminalFindQuery, setTerminalFindResults, stepTerminalFind, useTerminalFindStore } from "./terminalFind";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

const session = (id: string) => useTerminalFindStore.getState().byTerminal[id];
const releases: (() => void)[] = [];

function host(id: string) {
  const step = vi.fn();
  releases.push(registerTerminalFindHost(id, { step }));
  return step;
}

/** A terminal box as TerminalHost renders it, with a focusable inside. */
function box(id: string): HTMLElement {
  const el = document.createElement("div");
  el.dataset.terminalBox = id;
  const field = document.createElement("textarea");
  el.append(field);
  document.body.append(el);
  field.focus();
  return el;
}

afterEach(() => {
  for (const r of releases.splice(0)) r();
  document.body.replaceChildren();
  useTerminalFindStore.setState({ byTerminal: {} });
  useTerminalsStore.setState({ byId: {}, order: [] });
});

describe("terminal find sessions", () => {
  it("opening again asks the bar for the keyboard and keeps the query", () => {
    openTerminalFind("t1");
    setTerminalFindQuery("t1", "resize");
    openTerminalFind("t1");
    expect(session("t1")).toMatchObject({ query: "resize", focusSeq: 2 });
  });

  it("keeps a query per terminal, and closing one leaves the other", () => {
    openTerminalFind("t1");
    openTerminalFind("t2");
    setTerminalFindQuery("t1", "one");
    setTerminalFindQuery("t2", "two");
    closeTerminalFind("t1");
    expect(session("t1")).toBeUndefined();
    expect(session("t2")?.query).toBe("two");
  });

  it("ignores a query or results for a closed bar", () => {
    setTerminalFindQuery("t1", "x");
    setTerminalFindResults("t1", { index: 0, total: 1, capped: false });
    expect(session("t1")).toBeUndefined();
  });

  it("the same results leave the session alone, so the bar does not render for a re-search", () => {
    openTerminalFind("t1");
    setTerminalFindResults("t1", { index: 0, total: 1, capped: false });
    const before = session("t1");
    setTerminalFindResults("t1", { index: 0, total: 1, capped: false });
    expect(session("t1")).toBe(before);
  });

  it("a step with the bar closed opens it; with it open it goes to the terminal's host", () => {
    const step = host("t1");
    stepTerminalFind("t1", 1);
    expect(step).not.toHaveBeenCalled();
    expect(session("t1")).toBeDefined();
    stepTerminalFind("t1", -1);
    expect(step).toHaveBeenCalledWith(-1);
  });

  it("a terminal that goes takes its session; one that stays keeps it", () => {
    const t = { id: "t1" } as TerminalView;
    const other = { id: "t2" } as TerminalView;
    useTerminalsStore.setState({ byId: { t1: t, t2: other }, order: ["t1", "t2"] });
    openTerminalFind("t1");
    openTerminalFind("t2");
    useTerminalsStore.setState({ byId: { t2: other }, order: ["t2"] });
    expect(session("t1")).toBeUndefined();
    expect(session("t2")).toBeDefined();
  });

  it("a session for a terminal the list never had survives a list update", () => {
    openTerminalFind("t-plugin");
    useTerminalsStore.setState({ byId: { t2: { id: "t2" } as TerminalView }, order: ["t2"] });
    expect(session("t-plugin")).toBeDefined();
  });
});

describe("presentTerminalFind", () => {
  it("does nothing with no terminal on screen", () => {
    expect(presentTerminalFind("open")).toBe(false);
  });

  it("goes to the terminal with the keyboard, over the one that had it last", () => {
    host("t1");
    host("t2");
    noteTerminalKeyboard("t1");
    box("t2");
    expect(presentTerminalFind("open")).toBe(true);
    expect(session("t2")).toBeDefined();
    expect(session("t1")).toBeUndefined();
  });

  it("with the keyboard elsewhere (the palette), to the one that had it last", () => {
    host("t1");
    host("t2");
    noteTerminalKeyboard("t2");
    presentTerminalFind("open");
    expect(session("t2")).toBeDefined();
  });

  it("not to a last terminal that left the screen, but to one still on it", () => {
    host("t1");
    const release = registerTerminalFindHost("t2", { step: () => undefined });
    noteTerminalKeyboard("t2");
    release();
    presentTerminalFind("open");
    expect(session("t1")).toBeDefined();
    expect(session("t2")).toBeUndefined();
  });

  it("from the palette, after it closes and hands the keyboard back", async () => {
    host("t1");
    noteTerminalKeyboard("t1");
    useUiStore.getState().openPalette();
    expect(presentTerminalFind("open")).toBe(true);
    expect(session("t1")).toBeUndefined();
    useUiStore.getState().closePalette();
    await vi.waitFor(() => {
      expect(session("t1")).toBeDefined();
    });
  });

  it("next and previous step an open bar", () => {
    const step = host("t1");
    openTerminalFind("t1");
    presentTerminalFind("next");
    presentTerminalFind("previous");
    expect(step.mock.calls).toEqual([[1], [-1]]);
  });
});
