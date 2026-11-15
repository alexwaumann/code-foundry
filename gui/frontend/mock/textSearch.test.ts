import { afterEach, describe, expect, it } from "vitest";
import { ConnectError } from "@connectrpc/connect";
import { resetCompletion, setMockFiles } from "./filesystem";
import { resetIgnored } from "./includeIgnored";
import { caseSensitive, cutLine, resetText, searchTextMessages, setMockText, TEXT_LIMITS, type TextSearchRequest } from "./textSearch";

// The mock mirrors internal/textsearch (tested in Go against the real ripgrep); these pin what
// the GUI builds against.
const projects = new Map([
  ["repo-cf", { id: "repo-cf", name: "code-foundry", path: "/Users/dev/src/code-foundry" }],
  ["repo-gp", { id: "repo-gp", name: "ghostty-playground", path: "/Users/dev/src/ghostty-playground" }],
  ["plain", { id: "plain", name: "plain", path: "/Users/dev/plain", git: false }],
]);
const noDisk = () => null;

function search(query: string, opts: Partial<TextSearchRequest> = {}, includes: readonly string[] = [".env*"]) {
  const msgs = searchTextMessages(projects, { sources: [{ projectId: "repo-cf", path: "" }], query, matchCase: false, wholeWord: false, regex: false, ...opts }, includes, noDisk);
  const summary = msgs.at(-1)?.summary;
  expect(msgs.slice(0, -1).every((m) => m.summary === undefined && (m.files?.length ?? 0) > 0)).toBe(true);
  const files = msgs.flatMap((m) => m.files ?? []);
  // "project:path(!):line:text" with each range in brackets.
  const rows = files.flatMap((f) =>
    (f.lines ?? []).map((l) => {
      const cps = Array.from(l.text ?? "");
      let at = 0;
      let s = "";
      for (const r of l.ranges ?? []) {
        s += cps.slice(at, r.start).join("") + "[" + cps.slice(r.start, r.end).join("") + "]";
        at = r.end ?? 0;
      }
      return `${f.projectId ?? ""}:${f.path ?? ""}${f.ignored ? "!" : ""}:${String(l.line)}:${s + cps.slice(at).join("")}`;
    }),
  );
  return { files, rows, summary };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ConnectError ? err.rawMessage : String(err);
  }
  return "";
}

afterEach(() => {
  resetCompletion();
  resetIgnored();
  resetText();
});

describe("SearchText (mock)", () => {
  it("smart case, match case, whole word, phrases and literal characters", () => {
    setMockFiles("repo-cf", ["a.go", "b.txt", "c.md"]);
    setMockText("repo-cf", "a.go", "func Home() {}\nfunc home() {}\nhomeless := 1\n");
    setMockText("repo-cf", "b.txt", "a.*[b and a.b\n-v is a flag\nfunc  Home spaced\n");
    setMockText("repo-cf", "c.md", "Ünïcödé home ÜNÏ\n");
    expect(search("home").rows).toEqual([
      "repo-cf:a.go:1:func [Home]() {}",
      "repo-cf:a.go:2:func [home]() {}",
      "repo-cf:a.go:3:[home]less := 1",
      "repo-cf:b.txt:3:func  [Home] spaced",
      "repo-cf:c.md:1:Ünïcödé [home] ÜNÏ",
    ]);
    const upper = search("Home");
    expect(upper.rows).toEqual(["repo-cf:a.go:1:func [Home]() {}", "repo-cf:b.txt:3:func  [Home] spaced"]);
    expect(upper.summary?.caseSensitive).toBe(true);
    expect(search("home", { matchCase: true }).summary?.caseSensitive).toBe(true);
    expect(search("home", { wholeWord: true }).rows).not.toContain("repo-cf:a.go:3:[home]less := 1");
    expect(search("func home").rows).toEqual(["repo-cf:a.go:1:[func Home]() {}", "repo-cf:a.go:2:[func home]() {}"]);
    expect(search(".*[").rows).toEqual(["repo-cf:b.txt:1:a[.*[]b and a.b"]);
    expect(search("-v").rows).toEqual(["repo-cf:b.txt:2:[-v] is a flag"]);
    expect(search("ünï").rows).toEqual(["repo-cf:c.md:1:[Ünï]cödé home [ÜNÏ]"]);
    expect(search("cödé home").rows).toEqual(["repo-cf:c.md:1:Ünï[cödé home] ÜNÏ"]);
    expect(search(String.raw`a\.b|h\w+less`, { regex: true }).rows).toEqual(["repo-cf:a.go:3:[homeless] := 1", "repo-cf:b.txt:1:a.*[b and [a.b]"]);
  });

  it("smart case skips a regex's escapes", () => {
    expect(caseSensitive(String.raw`\Wfoo\S+`, false, true)).toBe(false);
    expect(caseSensitive(String.raw`\p{Lu}x`, false, true)).toBe(false);
    expect(caseSensitive(String.raw`\W`, false, false)).toBe(true);
    expect(caseSensitive("Élan", false, false)).toBe(true);
  });

  it("refuses what the daemon refuses", () => {
    expect(code(() => search("(foo", { regex: true }))).toMatch(/^invalid regular expression: /);
    expect(code(() => search("foo\\", { regex: true }))).toBe("invalid regular expression: it ends with a lone \\ (write \\\\ for a backslash)");
    expect(code(() => search("(foo"))).toBe("");
    expect(code(() => search("a\nb"))).toBe("the query is more than one line");
    expect(code(() => search("x".repeat(TEXT_LIMITS.maxQueryChars + 1)))).toBe("the query is 501 characters long, at most 500");
    expect(code(() => searchTextMessages(projects, { sources: [], query: "x", matchCase: false, wholeWord: false, regex: false }, [], noDisk))).toBe("sources is required");
  });

  it("covers SearchFiles' files: included ignored files flagged, node_modules out", () => {
    // The default files plus IGNORED's: .env* is included, node_modules is not.
    const { rows } = search("API_URL");
    expect(rows).toEqual(["repo-cf:.env!:1:[API_URL]=http://localhost:8080", "repo-cf:src/.env.test!:1:[API_URL]=http://localhost:9999"]);
    expect(search("API_URL", {}, []).rows).toEqual([]);
    expect(search("node_modules/react").rows).toEqual([]);
  });

  it("orders sources as sent, files by path", () => {
    setMockFiles("repo-cf", ["z.txt", "b/y.txt"]);
    setMockFiles("repo-gp", ["a.txt"]);
    for (const [p, f] of [["repo-cf", "z.txt"], ["repo-cf", "b/y.txt"], ["repo-gp", "a.txt"]] as const) setMockText(p, f, `needle ${f}\n`);
    const msgs = searchTextMessages(
      projects,
      { sources: [{ projectId: "repo-gp", path: "" }, { projectId: "repo-cf", path: "" }], query: "needle", matchCase: false, wholeWord: false, regex: false },
      [],
      noDisk,
    );
    expect(msgs.flatMap((m) => (m.files ?? []).map((f) => `${f.projectId ?? ""}:${f.path ?? ""}`))).toEqual(["repo-gp:a.txt", "repo-cf:b/y.txt", "repo-cf:z.txt"]);
    expect(msgs.at(-1)?.summary?.files).toBe(3);
  });

  it("caps lines per file and per search, counts on, skips binaries", () => {
    const files = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
    setMockFiles("repo-cf", [...files, "bin.dat"]);
    for (const f of files) setMockText("repo-cf", f, "needle\n".repeat(60));
    setMockText("repo-cf", "bin.dat", "needle\0\n");
    const { files: got, summary } = search("needle");
    expect(got[0]?.lines).toHaveLength(TEXT_LIMITS.fileLines);
    expect(got[0]?.lineCount).toBe(60);
    expect(got.map((f) => f.lines?.length ?? 0).reduce((a, b) => a + b)).toBe(TEXT_LIMITS.totalLines);
    expect(got).toHaveLength(40);
    expect(summary).toMatchObject({ lines: TEXT_LIMITS.totalLines, files: 40, fileCapped: true, totalCapped: true, truncated: true });
    setMockFiles("repo-cf", ["many.txt"]);
    setMockText("repo-cf", "many.txt", "needle\n".repeat(1200));
    expect(search("needle").files[0]).toMatchObject({ lineCount: TEXT_LIMITS.countLines, lineCountCapped: true });
  });

  it("cuts long lines around the first match, ranges in code points", () => {
    const line = "é".repeat(500) + "needle" + "x".repeat(500);
    const cut = cutLine(line, [{ start: 500, end: 506 }]);
    expect(cut).toMatchObject({ cutStart: true, cutEnd: true, ranges: [{ start: 40, end: 46 }] });
    expect(Array.from(cut.text ?? "")).toHaveLength(TEXT_LIMITS.lineChars);
    expect(Array.from(cut.text ?? "").slice(40, 46).join("")).toBe("needle");
    setMockFiles("repo-cf", ["emoji.txt"]);
    setMockText("repo-cf", "emoji.txt", "😀😀 needle\n");
    expect(search("needle").files[0]?.lines?.[0]?.ranges).toEqual([{ start: 3, end: 9 }]);
  });

  it("an empty query sends the summary alone", () => {
    const msgs = searchTextMessages(projects, { sources: [{ projectId: "repo-cf", path: "" }], query: "", matchCase: false, wholeWord: false, regex: false }, [], noDisk);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.summary?.files).toBe(0);
  });
});
