// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CompletionGroup } from "@/lib/completion";
import type { CompletionKey, EditorTrigger, PromptEditorHandle } from "./PromptEditor";
import { useCompletion, type Completion, type CompletionSource } from "./useCompletion";

const rows = (n: number, char: "/" | "@" = "@"): CompletionGroup[] => [
  {
    key: "r1",
    heading: null,
    items: Array.from({ length: n }, (_, i) => ({
      key: String(i),
      label: `f${String(i)}`,
      detail: "",
      tag: char === "@" ? { tagKind: "file" as const, repoId: "r1", path: `f${String(i)}` } : { tagKind: "skill" as const, repoId: "r1", name: `s${String(i)}` },
    })),
  },
];

const files = (over: Partial<CompletionSource>): CompletionSource => ({
  char: "@",
  label: "Files",
  available: true,
  groups: [],
  query: null,
  searching: false,
  emptyText: "No files match",
  ...over,
});

const skills = (n: number, query: string): CompletionSource => ({
  char: "/",
  label: "Skills",
  available: true,
  groups: rows(n, "/"),
  query,
  searching: false,
  emptyText: "No skills match",
});

function setup(trigger: EditorTrigger, source: CompletionSource) {
  const insertTag = vi.fn();
  const insertText = vi.fn();
  const out: { current: Completion | null } = { current: null };
  let trig = trigger;
  function Harness({ src, at }: { src: CompletionSource; at: EditorTrigger }) {
    const editorRef = useRef({ insertTag, insertText } as unknown as PromptEditorHandle) as RefObject<PromptEditorHandle | null>;
    out.current = useCompletion(at, () => undefined, src, editorRef);
    return null;
  }
  const view = render(<Harness src={source} at={trig} />);
  const c = () => {
    if (!out.current) throw new Error("not rendered");
    return out.current;
  };
  return {
    c,
    insertTag,
    insertText,
    update: (src: CompletionSource, next: EditorTrigger = trig) => {
      trig = next;
      view.rerender(<Harness src={src} at={trig} />);
    },
    key: (k: CompletionKey) => {
      let handled = false;
      act(() => {
        handled = c().onKey(k);
      });
      return handled;
    },
  };
}

const AT: EditorTrigger = { char: "@", query: "READ", from: 8, to: 13 };

describe("useCompletion with an asynchronous source: keys before and after the answer", () => {
  type Step = { key: CompletionKey; handled: boolean } | { answer: Partial<CompletionSource> };
  it.each<[string, Step[], Completion["show"]]>([
    [
      "Enter before the first answer is swallowed; the answer opens the list; Enter inserts",
      [{ key: "enter", handled: true }, { answer: { query: "READ", groups: rows(1) } }, { key: "enter", handled: true }],
      "list",
    ],
    [
      "Escape before the first answer dismisses: the answer does not open the card, Enter passes through",
      [{ key: "escape", handled: true }, { answer: { query: "READ", groups: rows(1) } }, { key: "enter", handled: false }],
      "none",
    ],
    [
      "Escape before the first answer, then an older query's answer: still closed",
      [{ key: "escape", handled: true }, { answer: { query: "REA", groups: rows(2) } }, { key: "enter", handled: false }],
      "none",
    ],
    [
      "a failed search answers with no matches: Enter closes the card, the next one passes through",
      [{ key: "enter", handled: true }, { answer: { query: "READ", groups: [] } }, { key: "enter", handled: true }, { key: "enter", handled: false }],
      "none",
    ],
    [
      "a slow answer says Searching…: Enter closes it, the next one passes through",
      [{ answer: { searching: true } }, { key: "enter", handled: true }, { key: "enter", handled: false }],
      "none",
    ],
    ["an outdated daemon: no card, Enter passes through at once", [{ answer: { available: false } }, { key: "enter", handled: false }], "none"],
    ["Tab and the arrows before the first answer pass through", [{ key: "tab", handled: false }, { key: "down", handled: false }], "none"],
  ])("%s", (_name, steps, show) => {
    const t = setup(AT, files({}));
    expect(t.c().show).toBe("none");
    for (const step of steps) {
      if ("answer" in step) t.update(files(step.answer));
      else expect(t.key(step.key)).toBe(step.handled);
    }
    expect(t.c().show).toBe(show);
  });

  it("once a trigger is answered, typing on keeps the last answer's rows until the next lands", () => {
    const t = setup({ ...AT, query: "REA" }, files({ query: "REA", groups: rows(2) }));
    expect(t.c().show).toBe("list");
    t.update(files({ query: "REA", groups: rows(2) }), AT); // READ typed, its answer not in yet
    expect(t.c().show).toBe("list");
    expect(t.key("enter")).toBe(true);
    expect(t.insertTag).toHaveBeenCalledTimes(1);
  });

  it("a new trigger is not answered by another trigger's answer for the same position's old query", () => {
    const t = setup(AT, files({ query: "zzz", groups: rows(2) }));
    expect(t.c().show).toBe("none");
    expect(t.key("enter")).toBe(true); // waiting
  });
});

describe("useCompletion with skills (unchanged by the file source)", () => {
  const SL: EditorTrigger = { char: "/", query: "de", from: 0, to: 3 };
  it.each<[string, number, CompletionKey[], boolean[], Completion["show"], number | null]>([
    ["arrows wrap, Enter inserts the selected row", 3, ["up", "enter"], [true, true], "list", 2],
    ["Tab inserts", 2, ["down", "tab"], [true, true], "list", 1],
    ["Escape dismisses, then Enter passes through", 2, ["escape", "enter"], [true, false], "none", null],
    ["no match: Tab passes through, Enter closes, then passes through", 0, ["tab", "enter", "enter"], [false, true, false], "none", null],
  ])("%s", (_name, n, keys, handled, show, inserted) => {
    const t = setup(SL, skills(n, "de"));
    expect(keys.map((k) => t.key(k))).toEqual(handled);
    expect(t.c().show).toBe(show);
    if (inserted === null) expect(t.insertTag).not.toHaveBeenCalled();
    else expect(t.insertTag).toHaveBeenCalledWith({ from: 0, to: 3 }, { tagKind: "skill", repoId: "r1", name: `s${String(inserted)}` });
  });
});

describe("useCompletion with a running thread's slash commands", () => {
  it("a built-in row inserts its plain text, a skill row its tag", () => {
    const groups: CompletionGroup[] = [
      { key: "~", heading: { kind: "user" }, items: [{ key: "commit", label: "/commit", detail: "", tag: { tagKind: "skill", repoId: "", name: "commit" } }] },
      { key: "claude", heading: { kind: "label", text: "Claude Code" }, items: [{ key: "compact", label: "/compact", hint: "<instructions>", detail: "", tag: "/compact" }] },
    ];
    const src: CompletionSource = { ...skills(0, "co"), label: "Slash commands", groups, emptyText: "No commands match" };
    const t = setup({ char: "/", query: "co", from: 4, to: 7 }, src);
    expect(t.key("down")).toBe(true);
    expect(t.key("enter")).toBe(true);
    expect(t.insertText).toHaveBeenCalledWith({ from: 4, to: 7 }, "/compact");
    expect(t.insertTag).not.toHaveBeenCalled();
    expect(t.key("up")).toBe(true);
    expect(t.key("tab")).toBe(true);
    expect(t.insertTag).toHaveBeenCalledWith({ from: 4, to: 7 }, { tagKind: "skill", repoId: "", name: "commit" });
  });
});
