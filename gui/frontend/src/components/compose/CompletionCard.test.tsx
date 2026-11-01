// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CompletionCard } from "./CompletionCard";
import type { EditorTrigger, PromptEditorHandle } from "./PromptEditor";
import { useCompletion, type CompletionSource } from "./useCompletion";

afterEach(cleanup);

const AT: EditorTrigger = { char: "@", query: "READM", from: 0, to: 6 };

const files = (over: Partial<CompletionSource>): CompletionSource => ({
  char: "@",
  label: "Files",
  available: true,
  groups: [],
  query: null,
  searching: false,
  emptyText: "No threads or files match",
  ...over,
});

function Card({ source }: { source: CompletionSource }) {
  const editorRef = useRef({ insertTag: () => undefined, insertText: () => undefined } as unknown as PromptEditorHandle) as RefObject<PromptEditorHandle | null>;
  const completion = useCompletion(AT, () => undefined, source, editorRef);
  return <CompletionCard completion={completion} />;
}

const hidden = (testId: string) => screen.getByTestId(testId).classList.contains("hidden");

// The keys before and after an answer are useCompletion.test.tsx's; this is what the card shows.
describe("CompletionCard while a file search is out or has failed", () => {
  it("a slow search says Searching… with the hints hidden; the rows replace it, with the hints", () => {
    const view = render(<Card source={files({ searching: true })} />);
    expect(screen.getByTestId("completion-searching").textContent).toBe("Searching…");
    expect(screen.queryByTestId("completion-item")).toBeNull();
    expect(hidden("completion-hints")).toBe(true);
    const groups = [{ key: "r", heading: null, items: [{ key: "README.md", label: "README.md", detail: "", tag: { tagKind: "file" as const, projectId: "r", path: "README.md" } }] }];
    view.rerender(<Card source={files({ query: "READM", groups })} />);
    expect(screen.queryByTestId("completion-searching")).toBeNull();
    expect(screen.getAllByTestId("completion-label").map((l) => l.textContent)).toEqual(["README.md"]);
    expect(hidden("completion-hints")).toBe(false);
  });

  it("a failed search answers with no matches: the source's empty text, no hints", () => {
    render(<Card source={files({ query: "READM", groups: [] })} />);
    expect(screen.getByTestId("completion-empty").textContent).toBe("No threads or files match");
    expect(hidden("completion-hints")).toBe(true);
  });
});
