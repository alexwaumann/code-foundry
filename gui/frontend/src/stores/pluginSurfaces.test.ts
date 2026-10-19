import { describe, expect, it } from "vitest";
import type { PluginViewModel } from "@/api/plugin";
import { demoView } from "@/test/pluginFixtures";
import { appendToLog, appendToView, applySurfaceUpdate, draftKeyOf, emptyEntry, formHasErrors, formsOf, LOG_MAX_LINES, reconcileResets, settleSubmits, unknownNodes } from "./pluginSurfaces";

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

  it("finds a log inside a pane inside a column, keeping the other lists as they were", () => {
    const v = demoView("layout");
    const out = appendToView(v, "layout-log", "", [{ text: "step 25  ok" }]);
    const left = out.nodes[1]?.columns?.items[0]?.children[0]?.pane?.children[0]?.log;
    expect(left?.lines?.at(-1)).toEqual({ text: "step 25  ok" });
    expect(left?.lines).toHaveLength(25);
    // Only the path to the log is new: the other column and the next node keep their identity.
    expect(out.nodes[1]?.columns?.items[1]).toBe(v.nodes[1]?.columns?.items[1]);
    expect(out.nodes[2]).toBe(v.nodes[2]);
    expect(v.nodes[1]?.columns?.items[0]?.children[0]?.pane?.children[0]?.log?.lines).toHaveLength(24);
    expect(appendToView(v, "layout-pane", "x", [])).toBe(v);
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

  it("keeps a submitted form's drafts while the plugin's next view shows errors for it", () => {
    const view = demoView("form");
    const dk = draftKeyOf("i", "form", "settings");
    const drafts = { [dk]: { name: "admin" } };
    const withError: PluginViewModel = {
      ...view,
      nodes: view.nodes.map((n) => (n.form ? { ...n, form: { ...n.form, fields: n.form.fields.map((f) => (f.name === "name" ? { ...f, error: "admin is reserved" } : f)) } } : n)),
    };
    // The view the submit acted on (version 3) does not settle it.
    let r = settleSubmits(drafts, { [dk]: 3 }, "i", withError, 3);
    expect(r.drafts).toBe(drafts);
    expect(r.submitted).toEqual({ [dk]: 3 });
    // The next one has errors: the drafts stay (the user fixes what they typed), the submit is settled.
    r = settleSubmits(drafts, { [dk]: 3 }, "i", withError, 4);
    expect(r.drafts).toBe(drafts);
    expect(r.submitted).toEqual({});
    // Without errors the drafts go.
    r = settleSubmits(drafts, { [dk]: 3 }, "i", view, 4);
    expect(r.drafts).toEqual({});
    // A view without the form (the plugin moved on) settles it too.
    r = settleSubmits(drafts, { [dk]: 3 }, "i", { ...view, nodes: [] }, 4);
    expect(r.drafts).toEqual({});
    // Another instance's submit is not this view's business.
    r = settleSubmits(drafts, { [dk]: 3 }, "other", view, 9);
    expect(r.drafts).toBe(drafts);
  });

  it("finds the plugin's errors on the form, a field, a fieldset or a field in one", () => {
    expect(formHasErrors({ fields: [] })).toBe(false);
    expect(formHasErrors({ fields: [], error: "no" })).toBe(true);
    expect(formHasErrors({ fields: [{ key: "a", error: "x" }] })).toBe(true);
    expect(formHasErrors({ fields: [{ key: "fs", fieldset: { fields: [], error: "x" } }] })).toBe(true);
    expect(formHasErrors({ fields: [{ key: "fs", fieldset: { fields: [{ key: "b", error: "x" }] } }] })).toBe(true);
  });

  it("lists forms at any depth", () => {
    expect(formsOf(demoView("form").nodes).map((f) => f.key)).toEqual(["settings"]);
    expect(formsOf([{ key: "s", section: { children: [{ key: "f", form: { fields: [] } }] } }]).map((f) => f.key)).toEqual(["f"]);
    const form = (key: string) => ({ key, form: { fields: [] } });
    expect(
      formsOf([{ key: "c", columns: { items: [{ key: "a", children: [form("f1")] }, { key: "b", children: [{ key: "p", pane: { children: [form("f2")] } }] }] } }]).map((f) => f.key),
    ).toEqual(["f1", "f2"]);
  });

  it("names nodes of kinds this GUI does not know", () => {
    expect(unknownNodes(demoView("overview").nodes)).toEqual([]);
    expect(unknownNodes([{ key: "x" }, { key: "s", section: { children: [{ key: "y" }] } }])).toEqual(["x", "y"]);
    expect(unknownNodes(demoView("layout").nodes)).toEqual([]);
    expect(unknownNodes([{ key: "c", columns: { items: [{ key: "a", children: [] }, { key: "b", children: [{ key: "p", pane: { children: [{ key: "z" }] } }] }] } }])).toEqual(["z"]);
  });
});
