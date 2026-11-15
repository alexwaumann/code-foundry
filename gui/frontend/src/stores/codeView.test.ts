import { afterEach, describe, expect, it } from "vitest";
import { setDiffStyle, setPreviewMode, setWrap, useCodeViewStore } from "./codeView";

/** One choice for every diff and file (docs/notes/file-viewer-3-tabs.md), kept in localStorage. */

const KEY = "code-foundry.codeView";
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as { state?: Record<string, unknown> };

afterEach(() => {
  useCodeViewStore.setState({ diffStyle: "unified", wrap: false, preview: {} });
  localStorage.clear();
});

describe("codeView", () => {
  it("saves the diff style, the wrap and each kind's preview mode", () => {
    setDiffStyle("split");
    setWrap(true);
    setPreviewMode("markdown", "source");
    setPreviewMode("svg", "image");
    expect(saved().state).toEqual({ diffStyle: "split", wrap: true, preview: { markdown: "source", svg: "image" } });
  });

  it("restores what was saved; an unknown value keeps the current choice, and a mode is any string (the kind judges it)", async () => {
    setPreviewMode("html", "source");
    localStorage.setItem(KEY, JSON.stringify({ version: 1, state: { diffStyle: "split", wrap: "yes", preview: { markdown: "source" } } }));
    await useCodeViewStore.persist.rehydrate();
    expect(useCodeViewStore.getState()).toMatchObject({ diffStyle: "split", wrap: false, preview: { markdown: "source", html: "source" } });
    localStorage.setItem(KEY, JSON.stringify({ version: 1, state: { diffStyle: "sideways", preview: { html: "raw", svg: 3, log: null } } }));
    await useCodeViewStore.persist.rehydrate();
    expect(useCodeViewStore.getState()).toMatchObject({ diffStyle: "split", preview: { markdown: "source", html: "raw" } });
    expect(useCodeViewStore.getState().preview).not.toHaveProperty("svg");
    localStorage.setItem(KEY, JSON.stringify({ version: 1, state: { preview: "rendered" } }));
    await useCodeViewStore.persist.rehydrate();
    expect(useCodeViewStore.getState().preview).toMatchObject({ markdown: "source" });
  });
});
