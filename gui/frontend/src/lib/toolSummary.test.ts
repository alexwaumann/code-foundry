import { describe, expect, it } from "vitest";
import type { ToolCallView } from "@/api/thread";
import { agentReport, diffStats, diffText, exitCode, formatDuration, num, obj, parseObject, patchHunks, splitPath, str, firstPatchLine, structuredPatchText, toolDiff, toolDiffFiles, toolFileTarget, toolSummary, type Tense, type ToolDiff } from "./toolSummary";

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

const stats = (d: ToolDiff | null) => (d ? diffStats(toolDiffFiles(d)) : null);

describe("toolDiff", () => {
  it("prefers the result's structuredPatch, as a git-style patch with real line numbers", () => {
    const t = call("Edit", { file_path: "/w/a.go", old_string: "x", new_string: "y" }, { resultJson: JSON.stringify({ structuredPatch: [{ oldStart: 40, oldLines: 2, newStart: 40, newLines: 2, lines: [" a", "-x", "+y"] }] }) });
    const d = toolDiff(t);
    expect(d).toEqual({ kind: "patch", path: "/w/a.go", patch: "diff --git a/w/a.go b/w/a.go\n--- a/w/a.go\n+++ b/w/a.go\n@@ -40,2 +40,2 @@\n a\n-x\n+y\n" });
    const [f] = d ? toolDiffFiles(d) : [];
    expect(f?.name).toBe("w/a.go");
    expect(f?.hunks[0]?.additionStart).toBe(40);
    expect(stats(d)).toEqual({ added: 1, removed: 1 });
    // Without it (no result yet: waiting for permission) the position is unknown: no line numbers.
    expect(toolDiff({ ...t, resultJson: "" })).toEqual({ kind: "contents", path: "/w/a.go", name: "a.go", pairs: [{ oldText: "x\n", newText: "y\n" }], numbered: false });
  });
  it("Write: a new file is all added and numbered; an update that changed nothing has no diff", () => {
    const w = call("Write", { file_path: "/w/a", content: "x\ny" });
    expect(toolDiff(w)).toMatchObject({ kind: "contents", pairs: [{ oldText: null, newText: "x\ny" }], numbered: true });
    expect(stats(toolDiff(w))).toEqual({ added: 2, removed: 0 });
    expect(toolDiff({ ...w, resultJson: JSON.stringify({ type: "update", structuredPatch: [] }) })).toBeNull();
  });
  it("an Edit with an empty old_string adds its text; one that changes nothing has no diff; replace_all says every occurrence", () => {
    expect(stats(toolDiff(call("Edit", { old_string: "", new_string: "a\nb" })))).toEqual({ added: 2, removed: 0 });
    expect(toolDiff(call("Edit", { old_string: "a", new_string: "a" }))).toBeNull();
    expect(sum(call("Edit", { file_path: "/w/repo/a.go", old_string: "x", new_string: "y", replace_all: true }))).toMatchObject({ added: 1, removed: 1, meta: "every occurrence" });
  });
  it("MultiEdit keeps one pair per edit", () => {
    const d = toolDiff(call("MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d\ne" }] }));
    expect(d?.kind === "contents" && d.pairs).toHaveLength(2);
    expect(stats(d)).toEqual({ added: 3, removed: 2 });
  });
  it("NotebookEdit shows the new cell source as added; a deleted cell has no diff", () => {
    expect(toolDiff(call("NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "print(1)", cell_type: "code" }))).toMatchObject({ name: "cell.py", pairs: [{ oldText: null, newText: "print(1)\n" }], numbered: false });
    expect(toolDiff(call("NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "# Hi", cell_type: "markdown" }))).toMatchObject({ name: "cell.md" });
    expect(toolDiff(call("NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "", edit_mode: "delete" }))).toBeNull();
  });
});

describe("diffText", () => {
  it("is the patch itself for a patch, else each pair's hunks without line numbers", () => {
    const patch = structuredPatchText("/w/a.go", [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }]);
    const p: ToolDiff = { kind: "patch", path: "/w/a.go", patch };
    expect(diffText(p, toolDiffFiles(p))).toBe(patch);
    const c: ToolDiff = { kind: "contents", path: "/w/a.go", name: "a.go", pairs: [{ oldText: "a\nb\n", newText: "a\nB\n" }], numbered: false };
    expect(diffText(c, toolDiffFiles(c))).toBe("@@\n a\n-b\n+B");
  });
});

describe("toolFileTarget", () => {
  const patch = (lines: string[], newStart = 10) => JSON.stringify({ structuredPatch: [{ oldStart: newStart, oldLines: 0, newStart, newLines: 0, lines }] });
  it.each<[string, ToolCallView, { path: string; line?: number } | null]>([
    ["a Read at its offset", call("Read", { file_path: "/w/a.ts", offset: 30, limit: 10 }), { path: "/w/a.ts", line: 30 }],
    ["a Read from the top", call("Read", { file_path: "/w/a.ts" }), { path: "/w/a.ts" }],
    ["an Edit at its first added line", call("Edit", { file_path: "/w/a.ts" }, { resultJson: patch([" x", " y", "+z"]) }), { path: "/w/a.ts", line: 12 }],
    ["an Edit at its first removal", call("Edit", { file_path: "/w/a.ts" }, { resultJson: patch([" x", "-y", "+z"]) }), { path: "/w/a.ts", line: 11 }],
    ["an Edit still waiting (no result)", call("Edit", { file_path: "/w/a.ts" }, { status: "running" }), { path: "/w/a.ts" }],
    ["a new file's Write", call("Write", { file_path: "/w/n.go" }, { resultJson: patch(["+package n"], 0) }), { path: "/w/n.go", line: 1 }],
    ["a NotebookEdit", call("NotebookEdit", { notebook_path: "/w/n.ipynb" }), { path: "/w/n.ipynb" }],
    ["a Bash call", call("Bash", { command: "ls" }), null],
    ["a Read without a path", call("Read", {}), null],
  ])("%s", (_, t, want) => {
    expect(toolFileTarget(t)).toEqual(want);
  });

  it("firstPatchLine skips hunks without a change", () => {
    expect(firstPatchLine([])).toBeNull();
    expect(firstPatchLine([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" a"] }, { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: ["+b"] }])).toBe(9);
  });
});

// Malformed payloads from the fuzz pass: each used to throw while rendering and blank the
// window. They now degrade to what the well-formed parts say.
describe("malformed payloads", () => {
  it.each<[string, ToolCallView]>([
    ["an Edit with a null hunk", call("Edit", { file_path: "/w/a.go", old_string: "x", new_string: "y" }, { resultJson: '{"structuredPatch":[null]}' })],
    ["an Edit hunk without lines", call("Edit", { file_path: "/w/a.go" }, { resultJson: '{"structuredPatch":[{"oldStart":1}]}' })],
    ["a MultiEdit with a null edit", call("MultiEdit", { file_path: "/w/a.go", edits: [null, { old_string: "a", new_string: "b" }] })],
    ["a TodoWrite with a null todo", call("TodoWrite", { todos: [null, { content: "x", status: "completed" }] })],
    ["an Agent result with null content", call("Agent", { description: "d" }, { resultJson: '{"content":[null,{"text":"done"}]}' })],
  ])("%s does not throw", (_, t) => {
    expect(() => {
      sum(t);
      const d = toolDiff(t);
      if (d) toolDiffFiles(d);
      toolFileTarget(t);
      agentReport(t);
    }).not.toThrow();
  });

  it("skips bad hunks and edits, keeping the good ones", () => {
    const bad = call("Edit", { file_path: "/w/a.go", old_string: "x", new_string: "y" }, { resultJson: '{"structuredPatch":[null]}' });
    expect(toolDiff(bad)).toMatchObject({ kind: "contents", pairs: [{ oldText: "x\n", newText: "y\n" }] });
    const multi = call("MultiEdit", { file_path: "/w/a.go", edits: [null, 3, { old_string: "a", new_string: "b" }] });
    expect(toolDiff(multi)).toMatchObject({ pairs: [{ oldText: "a\n", newText: "b\n" }] });
    expect(sum(call("TodoWrite", { todos: [null, { status: "completed" }] })).meta).toBe("1/1 done");
    expect(agentReport(call("Agent", {}, { resultJson: '{"content":[null,{"text":"done"}]}' }))).toBe("done");
  });

  it("str, num and obj read defaults from non-objects", () => {
    for (const v of [null, undefined, 3, "s", [1]]) {
      expect(str(v, "k")).toBe("");
      expect(num(v, "k")).toBeNull();
      expect(obj(v, "k")).toEqual({});
    }
  });

  it("patchHunks keeps hunks with a lines array, defaulting their numbers", () => {
    expect(patchHunks([null, { oldStart: 1 }, { lines: ["+a", 2] }, "x"])).toEqual([{ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: ["+a"] }]);
    expect(patchHunks({ lines: [] })).toEqual([]);
  });
});
