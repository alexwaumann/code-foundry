import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLayoutOp } from "@/api/layout";
import { fileTab } from "@/surfaces/fileTarget";
import { layoutSettled, resetFakeLayout, threadSeed } from "@/test/fakeLayout";
import {
  canSearchFile,
  closeFileFind,
  fileFindTabAt,
  finishFileFind,
  handOffFileFind,
  noteFileKeyboard,
  openFileFind,
  presentFileFind,
  registerFileFindHost,
  setFileFindCount,
  setFileFindCurrent,
  setFileFindDraft,
  setFileFindQuery,
  stepFileFind,
  useFileFindStore,
  type FileFindHost,
} from "./fileFind";
import { fileEditKey } from "./fileEdit";
import { openFileInPanel } from "./filePanel";
import { useLayoutStore } from "./layout";
import { useUiStore } from "./ui";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const session = (key: string) => useFileFindStore.getState().byTab[key];
const releases: (() => void)[] = [];

/** A File tab on screen: its root, with a focusable code box inside. */
function host(key: string) {
  const root = document.createElement("div");
  const code = document.createElement("div");
  code.tabIndex = -1;
  root.append(code);
  document.body.append(root);
  const h = { root, code, step: vi.fn<(dir: 1 | -1) => void>(), opened: vi.fn<() => void>(), finish: vi.fn<() => void>(), handOff: vi.fn<(query: string) => void>() };
  const asHost: FileFindHost = h;
  releases.push(registerFileFindHost(key, asHost));
  return h;
}

afterEach(() => {
  for (const r of releases.splice(0)) r();
  document.body.replaceChildren();
  useFileFindStore.setState({ byTab: {} });
});

describe("file find sessions", () => {
  it("opening again asks the bar for the keyboard and keeps the query; the body hears it", () => {
    const h = host("k1");
    openFileFind("k1");
    setFileFindQuery("k1", "needle");
    openFileFind("k1");
    expect(session("k1")).toMatchObject({ query: "needle", focusSeq: 2 });
    expect(h.opened).toHaveBeenCalledTimes(2);
  });

  it("ignores a query, a count, a match or a draft for a closed bar", () => {
    setFileFindQuery("k1", "x");
    setFileFindCount("k1", 0, 1, false);
    setFileFindCurrent("k1", { line: 0, nth: 0 }, true);
    setFileFindDraft("k1", "text");
    expect(session("k1")).toBeUndefined();
  });

  it("a current match asked to show raises the reveal, the same one in place leaves the session", () => {
    openFileFind("k1");
    setFileFindCurrent("k1", { line: 2, nth: 0 }, true);
    expect(session("k1")).toMatchObject({ current: { line: 2, nth: 0 }, revealSeq: 1 });
    const before = session("k1");
    setFileFindCurrent("k1", { line: 2, nth: 0 }, false);
    expect(session("k1")).toBe(before);
    setFileFindCurrent("k1", { line: 2, nth: 0 }, true);
    expect(session("k1")?.revealSeq).toBe(2);
  });

  it("a step with the bar closed opens it; with it open it goes to the tab's body", () => {
    const h = host("k1");
    stepFileFind("k1", 1);
    expect(h.step).not.toHaveBeenCalled();
    expect(session("k1")).toBeDefined();
    stepFileFind("k1", -1);
    expect(h.step).toHaveBeenCalledWith(-1);
  });

  it("finishing gives the keyboard back before the session ends", () => {
    const h = host("k1");
    openFileFind("k1");
    h.finish.mockImplementation(() => {
      expect(session("k1")).toBeDefined();
    });
    finishFileFind("k1");
    expect(h.finish).toHaveBeenCalledOnce();
    expect(session("k1")).toBeUndefined();
  });

  it("the editor's own find panel takes the query and the bar closes; an empty query hands nothing", () => {
    const h = host("k1");
    openFileFind("k1");
    setFileFindQuery("k1", "value");
    handOffFileFind("k1");
    expect(h.handOff).toHaveBeenCalledWith("value");
    expect(session("k1")).toBeUndefined();
    openFileFind("k1");
    handOffFileFind("k1");
    expect(h.handOff).toHaveBeenCalledOnce();
    expect(session("k1")).toBeUndefined();
  });

  it("a tab that closes takes its session; another tab's stays", async () => {
    await resetFakeLayout(threadSeed("s1"));
    openFileInPanel("thread:s1", { project: "", base: "/w", path: "fa" });
    openFileInPanel("thread:s1", { project: "", base: "/w", path: "fb" });
    await layoutSettled();
    const a = fileEditKey("thread:s1", fileTab({ project: "", base: "/w", path: "fa" }).id);
    const b = fileEditKey("thread:s1", fileTab({ project: "", base: "/w", path: "fb" }).id);
    openFileFind(a);
    openFileFind(b);
    const fa = Object.values(useLayoutStore.getState().tabs).find((t) => t.params.path === "/w/fa");
    await applyLayoutOp({ op: "close_tab", tab: fa?.id ?? "" });
    await layoutSettled();
    expect(session(a)).toBeUndefined();
    expect(session(b)).toBeDefined();
  });

  it("the palette lists the verbs only while a tab that can search is on screen", () => {
    expect(canSearchFile()).toBe(false);
    host("k1");
    expect(canSearchFile()).toBe(true);
  });

  it("finds the tab an element is in", () => {
    const h = host("k1");
    expect(fileFindTabAt(h.code)).toBe("k1");
    expect(fileFindTabAt(document.body)).toBeNull();
    expect(fileFindTabAt(null)).toBeNull();
  });
});

describe("presentFileFind", () => {
  it("does nothing with no File tab that can search on screen", () => {
    expect(presentFileFind("open")).toBe(false);
  });

  it("goes to the tab with the keyboard, over the one that had it last", () => {
    host("k1");
    const two = host("k2");
    noteFileKeyboard("k1");
    two.code.focus();
    expect(presentFileFind("open")).toBe(true);
    expect(session("k2")).toBeDefined();
    expect(session("k1")).toBeUndefined();
  });

  it("with the keyboard elsewhere (the palette, the CLI), to the one that had it last", () => {
    host("k1");
    host("k2");
    noteFileKeyboard("k2");
    presentFileFind("open");
    expect(session("k2")).toBeDefined();
  });

  it("not to a last tab that left the screen, but to one still on it", () => {
    host("k1");
    const gone = { root: document.createElement("div"), step: vi.fn(), opened: vi.fn(), finish: vi.fn(), handOff: vi.fn() };
    const release = registerFileFindHost("k2", gone);
    noteFileKeyboard("k2");
    release();
    presentFileFind("open");
    expect(session("k1")).toBeDefined();
    expect(session("k2")).toBeUndefined();
  });

  it("from the palette, after it closes and hands the keyboard back", async () => {
    host("k1");
    noteFileKeyboard("k1");
    useUiStore.getState().openPalette();
    expect(presentFileFind("open")).toBe(true);
    expect(session("k1")).toBeUndefined();
    useUiStore.getState().closePalette();
    await vi.waitFor(() => {
      expect(session("k1")).toBeDefined();
    });
  });

  it("next and previous step an open bar, and open a closed one", () => {
    const h = host("k1");
    presentFileFind("next");
    expect(session("k1")).toBeDefined();
    expect(h.step).not.toHaveBeenCalled();
    presentFileFind("previous");
    expect(h.step).toHaveBeenCalledWith(-1);
    closeFileFind("k1");
    expect(session("k1")).toBeUndefined();
  });
});
