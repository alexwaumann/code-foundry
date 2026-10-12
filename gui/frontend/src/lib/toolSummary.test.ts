import { describe, expect, it } from "vitest";
import type { ToolCallView } from "@/api/thread";
import { exitCode, formatDuration, parseObject, splitPath, toolHunks, toolSummary, type Tense } from "./toolSummary";

function call(name: string, input: object, over: Partial<ToolCallView> = {}): ToolCallView {
  return { toolUseId: "t", name, inputJson: JSON.stringify(input), status: "done", output: "", isError: false, resultJson: "", ...over };
}
const sum = (t: ToolCallView, tense: Tense = "done", durationMs?: number) => toolSummary(t, { tense, durationMs, cwd: "/w/repo" });

describe("helpers", () => {
  it("parseObject tolerates partial and non-object JSON", () => {
    expect(parseObject('{"a":1')).toEqual({});
    expect(parseObject("[1]")).toEqual({});
    expect(parseObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("splitPath relativizes inside cwd", () => {
    expect(splitPath("/w/repo/internal/x.go", "/w/repo/")).toEqual({ base: "x.go", dir: "internal" });
    expect(splitPath("/elsewhere/x.go", "/w/repo")).toEqual({ base: "x.go", dir: "/elsewhere" });
    expect(splitPath("x.go")).toEqual({ base: "x.go", dir: "" });
  });
  it.each([
    [10, ""],
    [900, "0.9s"],
    [41_000, "41s"],
    [248_000, "4m 08s"],
    [3_720_000, "1h 02m"],
  ])("formatDuration(%i) = %s", (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });
  it("exitCode reads Claude's error text", () => {
    expect(exitCode({ isError: false, output: "", status: "done" })).toBe(0);
    expect(exitCode({ isError: true, output: "Exit code 2\nboom", status: "error" })).toBe(2);
    expect(exitCode({ isError: true, output: "denied", status: "error" })).toBeNull();
    expect(exitCode({ isError: false, output: "", status: "running" })).toBeNull();
  });
});

describe("toolSummary", () => {
  it("Bash: tense, mono command, outcome chip, duration", () => {
    const bash = call("Bash", { command: "go test ./internal/store/pr/ -run TestFingerprint\necho done" });
    expect(sum(bash, "done", 900)).toMatchObject({ verb: "Ran", target: "go test ./internal/store/pr/ -run TestFingerprint …", targetStyle: "mono", chip: { tone: "ok", text: "ok" }, meta: "0.9s" });
    expect(sum({ ...bash, isError: true, status: "error", output: "Exit code 1\nFAIL" })).toMatchObject({ chip: { tone: "fail", text: "exit 1" } });
    expect(sum({ ...bash, status: "running" }, "running")).toMatchObject({ verb: "Running", chip: null });
    expect(sum(bash, "pending")).toMatchObject({ verb: "Run", chip: null });
  });
  it("Read: base name, dir, line count", () => {
    const read = call("Read", { file_path: "/w/repo/internal/store/pr/fingerprint.go" }, { resultJson: JSON.stringify({ type: "text", file: { numLines: 84 } }) });
    expect(sum(read)).toMatchObject({ verb: "Read", target: "fingerprint.go", detail: "internal/store/pr", meta: "84 lines" });
    expect(sum({ ...read, resultJson: JSON.stringify({ type: "image", file: {} }) }).meta).toBe("image");
  });
  it("Edit and Write count their lines; a created file says so", () => {
    const edit = call("Edit", { file_path: "/w/repo/a.go", old_string: "a\nb", new_string: "a\nc\nd" });
    expect(sum(edit)).toMatchObject({ verb: "Edited", target: "a.go", added: 2, removed: 1 });
    const write = call("Write", { file_path: "/w/repo/t.go", content: "1\n2\n3\n" }, { resultJson: JSON.stringify({ type: "create", structuredPatch: [] }) });
    expect(sum(write)).toMatchObject({ verb: "Created", added: 3, removed: 0 });
    expect(sum(write, "pending").verb).toBe("Write");
  });
  it("Grep and Glob: pattern, where, matches", () => {
    expect(sum(call("Grep", { pattern: "HeadRefOid", path: "/w/repo/internal" }, { resultJson: JSON.stringify({ mode: "content", numLines: 5, numFiles: 4 }) }))).toMatchObject({
      verb: "Searched for",
      target: "HeadRefOid",
      detail: "in internal",
      meta: "5 matches",
    });
    expect(sum(call("Grep", { pattern: "x" }, { resultJson: JSON.stringify({ mode: "files_with_matches", numFiles: 1 }) })).meta).toBe("1 file");
    expect(sum(call("Glob", { pattern: "**/*.go" }, { resultJson: JSON.stringify({ numFiles: 12 }) }))).toMatchObject({ verb: "Found", target: "**/*.go", meta: "12 files" });
  });
  it("Agent: description, type, tools and time", () => {
    const agent = call("Agent", { description: "Review the change", subagent_type: "code-reviewer" }, { resultJson: JSON.stringify({ totalToolUseCount: 4, totalDurationMs: 41_000 }) });
    expect(sum(agent)).toMatchObject({ verb: "Agent", target: "Review the change", detail: "code-reviewer", meta: "4 tools · 41s" });
  });
  it("MCP tools and unknown tools", () => {
    expect(sum(call("mcp__github__create_issue", { title: "x" }))).toMatchObject({ verb: "Used", target: "create_issue", detail: "github" });
    expect(sum(call("Frobnicate", { what: "the widget" }, { isError: true }))).toMatchObject({ verb: "Frobnicate", target: "the widget", chip: { tone: "fail", text: "error" } });
  });
});

describe("toolHunks", () => {
  it("prefers the result's structuredPatch", () => {
    const t = call("Edit", { old_string: "x", new_string: "y" }, { resultJson: JSON.stringify({ structuredPatch: [{ oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, lines: ["-x", "+y"] }] }) });
    expect(toolHunks(t)[0]?.oldStart).toBe(40);
    // Without it (no result yet: waiting for permission) the position is unknown: no line numbers.
    const [h] = toolHunks({ ...t, resultJson: "" });
    expect(h?.unnumbered).toBe(true);
    expect(h?.lines.map((l) => [l.oldNo, l.newNo])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
  it("Write: a new file is all added; an update that changed nothing has no diff", () => {
    const w = call("Write", { file_path: "/w/a", content: "x\ny" });
    expect(toolHunks(w)[0]?.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(toolHunks({ ...w, resultJson: JSON.stringify({ type: "update", structuredPatch: [] }) })).toEqual([]);
  });
  it("an Edit with an empty old_string adds its text; replace_all says every occurrence", () => {
    expect(toolHunks(call("Edit", { old_string: "", new_string: "a\nb" }))[0]?.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(sum(call("Edit", { file_path: "/w/repo/a.go", old_string: "x", new_string: "y", replace_all: true }))).toMatchObject({ added: 1, removed: 1, meta: "every occurrence" });
  });
  it("MultiEdit concatenates its edits' hunks", () => {
    expect(toolHunks(call("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }))).toHaveLength(2);
  });
});
