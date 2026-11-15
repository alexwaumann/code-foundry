import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { SearchTextSummarySchema, TextFileMatchSchema } from "@/gen/codefoundry/v1/filesystem_pb";
import { textSearchError, toTextFileView, toTextSummaryView } from "./textSearch";

describe("SearchText's messages as views", () => {
  it("maps a file and its lines, ranges from code points to UTF-16 (an emoji before and inside a match), empty ranges dropped", () => {
    const f = toTextFileView(
      create(TextFileMatchSchema, {
        projectId: "repo-cf",
        checkout: "/w/cf",
        path: ".env.local",
        ignored: true,
        lineCount: 999,
        lineCountCapped: true,
        lines: [{ line: 3, text: "😀 a😀b x", ranges: [{ start: 2, end: 5 }, { start: 6, end: 6 }], cutStart: true, cutEnd: false }],
      }),
    );
    expect(f).toEqual({
      projectId: "repo-cf",
      checkout: "/w/cf",
      path: ".env.local",
      ignored: true,
      lineCount: 999,
      lineCountCapped: true,
      lines: [{ line: 3, text: "😀 a😀b x", ranges: [{ start: 3, end: 7 }], cutStart: true, cutEnd: false }],
    });
  });

  it("maps the summary", () => {
    expect(toTextSummaryView(create(SearchTextSummarySchema, { lines: 12, files: 3, truncated: true, totalCapped: true, caseSensitive: true, elapsedMs: 42n }))).toEqual({
      lines: 12,
      files: 3,
      truncated: true,
      fileCapped: false,
      totalCapped: true,
      timedOut: false,
      caseSensitive: true,
      elapsedMs: 42,
    });
  });

  it("sorts errors: the query's own (InvalidArgument), ripgrep missing (FailedPrecondition), anything else", () => {
    expect(textSearchError(new ConnectError("invalid regular expression: unclosed group", Code.InvalidArgument))).toEqual({ kind: "query", message: "invalid regular expression: unclosed group" });
    expect(textSearchError(new ConnectError("text search is unavailable: ripgrep is missing", Code.FailedPrecondition))).toEqual({ kind: "unavailable", message: "text search is unavailable: ripgrep is missing" });
    expect(textSearchError(new ConnectError("boom", Code.Internal)).kind).toBe("other");
  });
});
