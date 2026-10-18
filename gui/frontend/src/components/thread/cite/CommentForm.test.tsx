// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentForm, type CiteOpen } from "./CiteLayer";

const open: CiteOpen = {
  mode: "comment",
  anchor: { itemId: "i1", start: 0, end: 5, x: 10 },
  body: { threadId: "s-1", itemId: "i1", text: "quote", comment: "", start: 0, end: 5, prefix: "", suffix: "" },
  editId: null,
  tint: "cf-cite-held",
};

function Harness({ onSave, onCancel, initial = "" }: { onSave: () => void; onCancel: () => void; initial?: string }) {
  const [comment, setComment] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  return <CommentForm open={open} shown comment={comment} setComment={setComment} fieldRef={ref} onSave={onSave} onCancel={onCancel} />;
}

afterEach(() => {
  cleanup();
});

describe("CommentForm keys", () => {
  it.each([
    ["Enter saves", { key: "Enter" }, 1],
    ["Shift+Enter is a new line", { key: "Enter", shiftKey: true }, 0],
    ["Alt+Enter does not save", { key: "Enter", altKey: true }, 0],
    ["Cmd+Enter does not save", { key: "Enter", metaKey: true }, 0],
    ["Enter while composing (IME) does not save", { key: "Enter", isComposing: true }, 0],
    ["other keys do not save", { key: "a" }, 0],
  ])("%s", (_name, init, saves) => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} onCancel={vi.fn()} />);
    const field = screen.getByTestId("cite-comment");
    fireEvent.keyDown(field, init);
    expect(onSave).toHaveBeenCalledTimes(saves);
  });

  it("the field has the keyboard, the caret at the end of a prefilled comment; Save and Cancel are buttons", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<Harness onSave={onSave} onCancel={onCancel} initial="Do this first." />);
    const field = screen.getByTestId<HTMLTextAreaElement>("cite-comment");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe("Do this first.".length);
    fireEvent.click(screen.getByTestId("cite-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cite-save"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("typing updates the comment (an empty one is fine)", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} onCancel={vi.fn()} />);
    const field = screen.getByTestId<HTMLTextAreaElement>("cite-comment");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: "Is it on main?\nCheck." } });
    expect(field.value).toBe("Is it on main?\nCheck.");
  });
});
