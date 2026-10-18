import { parseDiffFromFile } from "@pierre/diffs";
import { FileArchive, FileCode, FileImage, FileJson, FileTerminal, FileText, File as FileIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { HTML_PREVIEW_CSP, fileIconOf, firstChangeLine, formatSize, languageOf, lineCount, previewKindOf, sandboxedDocument, truncatedNotice } from "./fileKind";

describe("previewKindOf", () => {
  it.each([
    ["README.md", "markdown"],
    ["notes.MARKDOWN", "markdown"],
    ["page.mdx", "markdown"],
    ["index.html", "html"],
    ["old.HTM", "html"],
    ["app.ts", null],
    ["Makefile", null],
  ])("%s → %s", (p, want) => {
    expect(previewKindOf(p)).toBe(want);
  });
});

describe("languageOf", () => {
  it.each([
    ["a.ts", "TypeScript"],
    ["a.tsx", "TSX"],
    ["a.go", "Go"],
    ["README.md", "Markdown"],
    ["a.json", "JSON"],
    ["x.sh", "Shell"],
    ["a.rs", "Rust"],
    ["a.proto", "Protocol Buffers"],
    ["Makefile", "Makefile"],
    ["a.unknownext", "Plain text"],
  ])("%s → %s", (p, want) => {
    expect(languageOf(p)).toBe(want);
  });
});

describe("fileIconOf", () => {
  it("picks by type", () => {
    expect(fileIconOf("logo.png", "image/png")).toBe(FileImage);
    expect(fileIconOf("dist.tar")).toBe(FileArchive);
    expect(fileIconOf("package.json")).toBe(FileJson);
    expect(fileIconOf("run.sh")).toBe(FileTerminal);
    expect(fileIconOf("README.md")).toBe(FileText);
    expect(fileIconOf("main.go")).toBe(FileCode);
    expect(fileIconOf("LICENSE")).toBe(FileIcon);
  });
});

describe("sizes, lines, notices", () => {
  it("formatSize", () => {
    expect([79, 2048, 2_400_000, 4_400_000].map(formatSize)).toEqual(["79 B", "2 KB", "2.3 MB", "4.2 MB"]);
  });

  it("lineCount", () => {
    expect([lineCount(""), lineCount("a"), lineCount("a\n"), lineCount("a\nb"), lineCount("a\nb\n"), lineCount("\n\n")]).toEqual([0, 1, 1, 2, 2, 2]);
  });

  it("truncatedNotice", () => {
    expect(truncatedNotice(4_400_000)).toBe("Showing the first 1 MiB of 4.2 MB");
  });
});

describe("firstChangeLine", () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join("\n") + "\n";

  it("is the first added line of the new side", () => {
    const neu = old.replace("line 20\n", "line 20 changed\nextra\n");
    expect(firstChangeLine(parseDiffFromFile({ name: "a.ts", contents: old }, { name: "a.ts", contents: neu }))).toBe(20);
  });

  it("an added file starts at 1; no hunks: null", () => {
    expect(firstChangeLine(parseDiffFromFile(null, { name: "a.ts", contents: "x\n" }))).toBe(1);
    expect(firstChangeLine(parseDiffFromFile({ name: "a.ts", contents: old }, { name: "a.ts", contents: old }))).toBeNull();
  });
});

describe("sandboxedDocument", () => {
  it("puts the CSP first", () => {
    const doc = sandboxedDocument("<!doctype html><p>x</p>");
    expect(doc.startsWith(`<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`)).toBe(true);
    expect(HTML_PREVIEW_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  });

  it("the CSP lands in the head of the parsed document", () => {
    const parsed = new DOMParser().parseFromString(sandboxedDocument("<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>"), "text/html");
    expect(parsed.head.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull();
    expect(parsed.body.textContent).toBe("x");
  });
});
