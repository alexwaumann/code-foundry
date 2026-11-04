import { describe, expect, it } from "vitest";
import type { SearchActivityView } from "@/api/search";
import { searchRow } from "./searchActivity";

const none: SearchActivityView = { runningId: "", unseenId: "", unseenStatus: "done", unseenHits: 0 };

describe("searchRow", () => {
  it.each<[string, SearchActivityView | null, ReturnType<typeof searchRow>]>([
    ["before the first event", null, null],
    ["nothing to say", none, null],
    ["running", { ...none, runningId: "q-r" }, { id: "q-r", kind: "running", label: "Searching…", count: 0 }],
    ["finished with hits", { ...none, unseenId: "q-d", unseenHits: 5 }, { id: "q-d", kind: "results", label: "Search results", count: 5 }],
    ["finished without hits", { ...none, unseenId: "q-d" }, { id: "q-d", kind: "none", label: "No search results", count: 0 }],
    ["failed", { ...none, unseenId: "q-f", unseenStatus: "failed" }, { id: "q-f", kind: "failed", label: "Search failed", count: 0 }],
    ["failed with hits: still a failure", { ...none, unseenId: "q-f", unseenStatus: "failed", unseenHits: 2 }, { id: "q-f", kind: "failed", label: "Search failed", count: 0 }],
    ["finished before running", { ...none, runningId: "q-r", unseenId: "q-d", unseenHits: 1 }, { id: "q-d", kind: "results", label: "Search results", count: 1 }],
  ])("%s", (_name, a, want) => {
    expect(searchRow(a)).toEqual(want);
  });
});
