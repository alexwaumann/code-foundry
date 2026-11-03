// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchEntryView } from "@/api/search";
import { AnswerText } from "./AgentParts";
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

describe("AnswerText markers", () => {
  it("sit against the punctuation after them, and keep their gap before a word or another marker", () => {
    render(<AnswerText answer="The spot [1]. Both [2][3] and [4], then [5] here." />);
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
});

describe("RecentPreview", () => {
  it("a run that ended before any step has no summary line; one with steps has it", () => {
    render(<RecentPreview entry={entry({ status: "failed", error: "claude exited" })} />);
    expect(screen.queryByTestId("agent-summary")).toBeNull();
    cleanup();
    render(<RecentPreview entry={entry({ steps: [{ index: 0, kind: "search", done: true, failed: false, text: "Searched a · 1 hit", query: "a", threadName: "" }], searches: 1 })} />);
    expect(screen.getByTestId("agent-summary-toggle").textContent).toBe("1 search · read 0 threads");
  });
});
