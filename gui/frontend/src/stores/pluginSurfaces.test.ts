import { describe, expect, it } from "vitest";
import type { PluginViewModel } from "@/api/plugin";
import { demoView } from "@/test/pluginFixtures";
import { appendToLog, appendToView, applySurfaceUpdate, draftKeyOf, emptyEntry, formsOf, LOG_MAX_LINES, reconcileResets, unknownNodes } from "./pluginSurfaces";

const entry = emptyEntry({ plugin: "hello", surface: "demo" });

describe("applySurfaceUpdate", () => {
  it("takes the state, then views; a view clears a stream error", () => {
    let e = applySurfaceUpdate({ ...entry, error: "gone" }, { kind: "state", instance: "hello/demo/thread:s-1", phase: "opening", message: "", pluginState: "running" });
    expect(e).toMatchObject({ instance: "hello/demo/thread:s-1", phase: "opening", error: null });
    const view = demoView("overview");
    e = applySurfaceUpdate(e, { kind: "view", instance: "hello/demo/thread:s-1", version: 2, view, hostRendered: false });
    expect(e).toMatchObject({ version: 2, view });
    // A view that did not parse keeps the last one.
    expect(applySurfaceUpdate(e, { kind: "view", instance: "", version: 3, view: null, hostRendered: false })).toBe(e);
  });

  it("applies an append to the version on screen only", () => {
    const e = { ...entry, version: 4, view: demoView("log") };
    const next = applySurfaceUpdate(e, { kind: "append", instance: "", version: 4, key: "build-log", text: "[1/6] fetching sources\n", lines: [] });
    expect(next.view?.nodes.find((n) => n.key === "build-log")?.log?.text).toBe("[1/6] fetching sources\n");
    expect(applySurfaceUpdate(e, { kind: "append", instance: "", version: 3, key: "build-log", text: "x", lines: [] })).toBe(e);
    expect(applySurfaceUpdate(e, { kind: "toast", instance: "", level: "info", text: "saved" })).toBe(e);
  });
});

describe("logs", () => {
  it("appends text to a text log and lines to a lines log; text to a lines log splits", () => {
    expect(appendToLog({ text: "a\n" }, "b\n", []).text).toBe("a\nb\n");
    expect(appendToLog({ lines: [{ text: "a" }] }, "", [{ text: "b", tone: "error" }]).lines).toEqual([{ text: "a" }, { text: "b", tone: "error" }]);
    expect(appendToLog({ lines: [{ text: "a" }] }, "b\nc\n", []).lines).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect(appendToLog({}, "", [{ text: "x", tone: "attention" }]).lines).toEqual([{ text: "x", tone: "attention" }]);
  });

  it("keeps the last LOG_MAX_LINES lines and marks the log truncated", () => {
    const many = Array.from({ length: LOG_MAX_LINES }, (_, i) => `${String(i)}\n`).join("");
    const out = appendToLog({ text: many }, "last\n", []);
    expect(out.truncated).toBe(true);
    expect(out.text?.startsWith("1\n")).toBe(true);
    expect(out.text?.endsWith("last\n")).toBe(true);
    const lines = appendToLog({ lines: Array.from({ length: LOG_MAX_LINES }, (_, i) => ({ text: String(i) })) }, "", [{ text: "last" }]);
    expect(lines.lines?.length).toBe(LOG_MAX_LINES);
    expect(lines.lines?.[0]?.text).toBe("1");
    expect(lines.truncated).toBe(true);
  });

  it("finds a log inside a section and leaves the view alone for a key that is no log", () => {
    const v: PluginViewModel = { nodes: [{ key: "s", section: { children: [{ key: "l", log: { text: "" } }] } }] };
    expect(appendToView(v, "l", "x", []).nodes[0]?.section?.children[0]?.log?.text).toBe("x");
    expect(appendToView(v, "s", "x", [])).toBe(v);
    expect(appendToView(v, "nope", "x", [])).toBe(v);
  });
});

describe("drafts", () => {
  it("drops a form's drafts when its resetToken changes, and only then", () => {
    const view = demoView("form");
    const dk = draftKeyOf("i", "form", "settings");
    let r = reconcileResets({}, {}, "i", view);
    expect(r.resetTokens[dk]).toBe("0");
    const drafts = { [dk]: { name: "Ada" } };
    r = reconcileResets(drafts, r.resetTokens, "i", view);
    expect(r.drafts).toBe(drafts);
    const reset: PluginViewModel = { ...view, nodes: view.nodes.map((n) => (n.form ? { ...n, form: { ...n.form, resetToken: "1" } } : n)) };
    r = reconcileResets(drafts, r.resetTokens, "i", reset);
    expect(r.drafts).toEqual({});
    expect(r.resetTokens[dk]).toBe("1");
  });

  it("lists forms at any depth", () => {
    expect(formsOf(demoView("form").nodes).map((f) => f.key)).toEqual(["settings"]);
    expect(formsOf([{ key: "s", section: { children: [{ key: "f", form: { fields: [] } }] } }]).map((f) => f.key)).toEqual(["f"]);
  });

  it("names nodes of kinds this GUI does not know", () => {
    expect(unknownNodes(demoView("overview").nodes)).toEqual([]);
    expect(unknownNodes([{ key: "x" }, { key: "s", section: { children: [{ key: "y" }] } }])).toEqual(["x", "y"]);
  });
});
