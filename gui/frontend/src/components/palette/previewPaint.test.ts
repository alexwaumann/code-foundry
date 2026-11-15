import { describe, expect, it } from "vitest";
import { blankFile, type FileReadView } from "@/api/files";
import { previewView } from "./previewPaint";

const file = (text: string | null, o: Partial<FileReadView> = {}): FileReadView => ({ ...blankFile("/w/cf/a.ts"), text, size: text?.length ?? 0, ...o });
const read = (f: FileReadView | null, error: string | null = null) => ({ fileKey: "/w/cf/a.ts", file: f, error });
const TEXT = "one\n\tif h := os.Getenv(x) {\r\nthree\n";

describe("previewView: the file, or the row's line with why", () => {
  it.each<[string, ReturnType<typeof read>, { line: number; text: string }, string]>([
    ["the line as the search found it: code", read(file(TEXT)), { line: 2, text: "\tif h := os.Getenv(x) {" }, "code"],
    ["a cut row's text inside the line: code", read(file(TEXT)), { line: 2, text: "os.Getenv" }, "code"],
    ["the line no longer holds it", read(file(TEXT)), { line: 3, text: "Getenv" }, "The file changed since the search: its line no longer reads like this."],
    ["past the end", read(file(TEXT)), { line: 9, text: "x" }, "The file changed since the search: its line no longer reads like this."],
    ["the reader cut the file before the line", read(file("a\nb", { truncated: true, size: 3_000_000 })), { line: 2, text: "b" }, "The file is 2.9 MB: the preview reads its first 1 MiB, which ends before this line."],
    ["binary", read(file(null, { binary: true, size: 2048 })), { line: 1, text: "x" }, "Cannot show this file (2 KB, not text)."],
    ["gone", read(file(null, { notFound: true })), { line: 1, text: "x" }, "The file is gone since the search."],
    ["a failed read", read(null, "permission denied"), { line: 1, text: "x" }, "Cannot read the file: permission denied"],
  ])("%s", (_name, r, match, want) => {
    const v = previewView(r, match);
    expect(v.kind === "code" ? "code" : v.note).toBe(want);
  });
});
