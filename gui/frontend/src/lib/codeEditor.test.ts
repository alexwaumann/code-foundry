import { Editor, EditStateManager, TextDocument } from "@pierre/diffs/edit";
import { describe, expect, it, vi } from "vitest";
import { draftText, editorHandle, forgetDraft, loadCodeEditor } from "./codeEditor";

describe("the library's document", () => {
  it("hands back the line endings it was given, mixed ones too", () => {
    for (const text of ["a\r\nb\r\n", "a\nb\r\nc\rd", "no ending"]) expect(new TextDocument("f", text).getText()).toBe(text);
  });

  it("an edit leaves the other lines' endings alone", () => {
    const doc = new TextDocument("f", "a\r\nb\nc\r\n");
    doc.applyEdits([{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: "!" }], false);
    expect(doc.getText()).toBe("a\r\nb!\nc\r\n");
  });
});

describe("drafts", () => {
  it("are read from the library by key and go when forgotten", async () => {
    await loadCodeEditor();
    expect(draftText("k")).toBeNull();
    const owner = new Editor("file");
    EditStateManager.activate("file", "k", owner, { type: "file", document: new TextDocument("f", "secret"), fileInfo: { name: "f" } });
    expect(draftText("k")).toBe("secret");
    // Attached: still there, until the editor lets go.
    forgetDraft("k");
    expect(draftText("k")).toBe("secret");
    EditStateManager.releaseFile("k", owner);
    expect(draftText("k")).toBe("secret");
    forgetDraft("k");
    expect(draftText("k")).toBeNull();
  });
});

describe("the handle", () => {
  const fake = () => ({ focus: vi.fn(), getViewState: vi.fn(() => ({})), setSelections: vi.fn() });

  it("focus scrolls to the caret: the library's default", () => {
    const editor = fake();
    editorHandle(editor).focus({ line: 9, character: 3 });
    expect(editor.focus).toHaveBeenCalledWith({ lineNumber: 10, character: 3 });
  });

  it("focusInPlace never moves the view: the caret at the place, or where it was", () => {
    const editor = fake();
    const handle = editorHandle(editor);
    handle.focusInPlace({ line: 79, character: 0 });
    expect(editor.focus).toHaveBeenLastCalledWith({ lineNumber: 80, character: 0, preventScroll: true });
    handle.focusInPlace(null);
    expect(editor.focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });
});
