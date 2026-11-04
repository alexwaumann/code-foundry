// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchEntryView } from "@/api/search";
import { AnswerPane, AnswerRow, AnswerText } from "./AgentParts";
import { RecentPreview } from "./RecentSearches";

afterEach(cleanup);

function entry(over: Partial<SearchEntryView> = {}): SearchEntryView {
  return {
    id: "q-1",
    mode: "agent",
    query: "where?",
    createdAtMs: 0,
    finishedAtMs: 1,
    status: "done",
    error: "",
    answer: "",
    hits: [],
    steps: [],
    searches: 0,
    threadsRead: 0,
    model: "",
    costUsd: 0,
    durationMs: 0,
    unseen: false,
    version: 1,
    promotedThreadId: "",
    findHits: 0,
    ...over,
  };
}

const ns = (...n: number[]) => n.map((x) => ({ n: x }));

describe("AnswerText markers", () => {
  it("sit against the punctuation after them, and keep their gap before a word or another marker", () => {
    render(<AnswerText answer="The spot [1]. Both [2][3] and [4], then [5] here." hits={ns(1, 2, 3, 4, 5)} />);
    const gaps = screen.getAllByTestId("agent-answer-ref").map((r) => [r.textContent, r.className.includes("mx-px px-0.5")]);
    expect(gaps).toEqual([
      ["1", false],
      ["2", true],
      ["3", true],
      ["4", false],
      ["5", true],
    ]);
    expect(screen.getByTestId("agent-answer").textContent).toBe("The spot 1. Both 23 and 4, then 5 here.");
  });

  it.each([
    ["a paragraph", "It did [1]."],
    ["a list item", "- It did [1]"],
    ["an ordered item", "1. It did [1]"],
    ["a heading", "## It did [1]"],
    ["bold", "**It did [1]**"],
    ["a quote", "> It did [1]"],
    ["a table cell", "| a |\n| - |\n| It did [1] |"],
  ])("are buttons that select their hit in %s", (_name, answer) => {
    const onRef = vi.fn();
    render(<AnswerText answer={answer} hits={ns(1)} onRef={onRef} />);
    fireEvent.click(screen.getByRole("button", { name: "Result 1" }));
    expect(onRef).toHaveBeenCalledWith(1);
  });

  it("[1, 2] is two markers", () => {
    render(<AnswerText answer="See [1, 2]." hits={ns(1, 2)} onRef={vi.fn()} />);
    expect(screen.getAllByTestId("agent-answer-ref").map((r) => r.textContent)).toEqual(["1", "2"]);
  });

  it("code keeps its text: args[1] is no marker", () => {
    render(<AnswerText answer={"Inline `args[1]` here.\n\n```\nx[1]\n```"} hits={ns(1)} onRef={vi.fn()} />);
    expect(screen.queryByTestId("agent-answer-ref")).toBeNull();
    expect(screen.getByTestId("agent-answer").textContent).toContain("args[1]");
  });

  it("a number with no hit stays as typed: nothing to select", () => {
    const onRef = vi.fn();
    render(<AnswerText answer="Known [1], past the hits [7], an index [0]." hits={ns(1)} onRef={onRef} />);
    expect(screen.getAllByTestId("agent-answer-ref").map((r) => r.textContent)).toEqual(["1"]);
    expect(screen.getByTestId("agent-answer").textContent).toBe("Known 1, past the hits [7], an index [0].");
  });

  it("without onRef they only say which hit: no button that does nothing", () => {
    render(<AnswerText answer="It did [1]." hits={ns(1)} />);
    expect(screen.getByTestId("agent-answer-ref").textContent).toBe("1");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AnswerText markdown", () => {
  it("renders what the model wrote: bullets, bold, headings, code", () => {
    render(<AnswerText answer={"## Title\n\n- **one** [1]\n- `two`\n\n1. three"} hits={ns(1)} />);
    const a = screen.getByTestId("agent-answer");
    expect(a.querySelector("h2")?.textContent).toBe("Title");
    expect([...a.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["one 1", "two"]);
    expect(a.querySelector("strong")?.textContent).toBe("one");
    expect(a.querySelector("code")?.textContent).toBe("two");
    expect(a.querySelector("ol > li")?.textContent).toBe("three");
  });

  // The text derives from old thread content: nothing in it may load, navigate or become markup.
  it("an image loads nothing: its alt text shows", () => {
    render(<AnswerText answer="See ![x](https://example.com/track.png) there." hits={[]} />);
    const a = screen.getByTestId("agent-answer");
    expect(a.querySelector("img")).toBeNull();
    expect(a.innerHTML).not.toContain("example.com");
    expect(a.textContent).toBe("See x there.");
  });

  it.each([
    ["an image tag", '<img src="https://example.com/track.png" onerror="alert(1)">'],
    ["an image tag in a paragraph", 'Text <img src="https://example.com/track.png"> more.'],
    ["a script", "<script>alert(1)</script>"],
    ["a frame", '<iframe src="https://example.com"></iframe>'],
    ["an allowed inline pair", "<mark>not markup</mark>"],
  ])("raw HTML makes no element: %s", (_name, answer) => {
    render(<AnswerText answer={answer} hits={[]} />);
    const a = screen.getByTestId("agent-answer");
    expect(a.querySelector("img, script, iframe, mark")).toBeNull();
    // It stays visible, as typed.
    expect(a.textContent).toContain(answer.slice(0, 5).replace(/^Text /, ""));
  });

  it.each([
    ["a link", "[a](https://example.com)", "a"],
    ["a bare URL", "https://example.com", "https://example.com"],
    ["an autolink", "<https://example.com>", "https://example.com"],
    ["a reference link", "[a][r]\n\n[r]: https://example.com", "a"],
    ["a script link", "[a](javascript:alert(1))", "a"],
    ["an image in a link", "[![x](https://example.com/a.png)](https://example.com)", "x"],
  ])("%s is its text: no anchor, nothing to navigate", (_name, answer, text) => {
    render(<AnswerText answer={answer} hits={[]} />);
    const a = screen.getByTestId("agent-answer");
    expect(a.querySelector("a, img")).toBeNull();
    expect(a.textContent).toBe(text);
  });

  it("a raw anchor makes none either", () => {
    render(<AnswerText answer={'<a href="https://example.com">a</a>'} hits={[]} />);
    expect(screen.getByTestId("agent-answer").querySelector("a")).toBeNull();
  });
});

describe("AnswerRow", () => {
  it("shows plain text, clamped, and selects on a click", () => {
    const onSelect = vi.fn();
    render(<AnswerRow answer={"## Title\n\n**Bold** text [1]."} selected={false} onSelect={onSelect} />);
    const preview = screen.getByTestId("agent-answer-preview");
    expect(preview.textContent).toBe("Title Bold text.");
    expect(preview.className).toContain("line-clamp-2");
    fireEvent.click(screen.getByTestId("agent-answer-row"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("AnswerPane", () => {
  it("has the Answer overline over the whole answer", () => {
    render(<AnswerPane answer={"One [1].\n\nTwo."} hits={ns(1)} onRef={vi.fn()} />);
    const pane = screen.getByTestId("agent-answer-pane");
    expect(within(pane).getByText("Answer").className).toContain("text-overline");
    expect(within(pane).getByTestId("agent-answer").textContent).toContain("Two.");
  });
});

describe("RecentPreview", () => {
  it("renders a saved answer the same way, its markers saying which hit", () => {
    render(<RecentPreview entry={entry({ answer: "- **One** [1]\n- ![x](https://example.com/a.png) [a](https://example.com) [9]", hits: [] })} />);
    const a = screen.getByTestId("agent-answer");
    expect(a.querySelector("li strong")?.textContent).toBe("One");
    expect(a.querySelector("a, img")).toBeNull();
    expect(a.textContent).toContain("[9]");
  });

  it("a run that ended before any step has no summary line; one with steps has it", () => {
    render(<RecentPreview entry={entry({ status: "failed", error: "claude exited" })} />);
    expect(screen.queryByTestId("agent-summary")).toBeNull();
    cleanup();
    render(<RecentPreview entry={entry({ steps: [{ index: 0, kind: "search", done: true, failed: false, text: "Searched a · 1 hit", query: "a", threadName: "" }], searches: 1 })} />);
    expect(screen.getByTestId("agent-summary-toggle").textContent).toBe("1 search · read 0 threads");
  });
});
