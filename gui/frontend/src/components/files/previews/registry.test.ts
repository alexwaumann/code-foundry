import { describe, expect, it } from "vitest";
import { blankFile, type FileReadView } from "@/api/files";
import { PREVIEW_KINDS, pickMode, previewKindOf, previewModes, registryProblems } from "./registry";
import { SOURCE, type PreviewKind } from "./types";

/** A read of `path`: text unless `over` says otherwise. */
const read = (path: string, over: Partial<FileReadView> = {}): FileReadView => ({ ...blankFile(path), text: "x", size: 1, ...over });
const bytes = new Uint8Array([1]);
const kindOf = (path: string, over: Partial<FileReadView> = {}) => previewKindOf(path, read(path, over))?.id ?? null;

describe("the registered kinds", () => {
  it("are every file under kinds/, and none claims what another does", () => {
    expect(PREVIEW_KINDS.map((k) => k.id)).toEqual(expect.arrayContaining(["html", "image", "markdown", "pdf", "svg"]));
    expect(registryProblems(PREVIEW_KINDS)).toEqual([]);
  });

  it.each<[string, Partial<FileReadView>, string | null]>([
    ["README.md", { mime: "text/markdown" }, "markdown"],
    ["notes.MARKDOWN", {}, "markdown"],
    ["page.mdx", {}, "markdown"],
    ["index.html", { mime: "text/html" }, "html"],
    ["old.HTM", {}, "html"],
    ["logo.svg", { mime: "image/svg+xml", image: bytes }, "svg"],
    // No extension: the exact mime finds the SVG before image/* does.
    ["icon", { mime: "image/svg+xml", image: bytes }, "svg"],
    ["logo.png", { mime: "image/png", image: bytes, text: null, binary: true }, "image"],
    ["shot.webp", { mime: "image/webp", image: bytes, text: null, binary: true }, "image"],
    ["spec.pdf", { mime: "application/pdf", pdf: bytes, text: null, binary: true }, "pdf"],
    ["download", { mime: "application/pdf", pdf: bytes, text: null, binary: true }, "pdf"],
    ["architecture.mmd", { mime: "text/vnd.mermaid" }, "mermaid"],
    ["flow.MERMAID", {}, "mermaid"],
    ["diagram", { mime: "text/vnd.mermaid" }, "mermaid"],
    ["notes.mmdx", {}, null],
    ["customers.csv", { mime: "text/csv" }, "csv"],
    ["data.TSV", { mime: "text/tab-separated-values" }, "csv"],
    ["package.json", { mime: "application/json" }, "json"],
    ["settings.jsonc", { mime: "application/json" }, "json"],
    ["results.jsonl", { mime: "application/jsonl" }, "jsonl"],
    ["events.ndjson", { mime: "application/jsonl" }, "jsonl"],
    ["export", { mime: "text/csv" }, "csv"],
    // A cut JSON read cannot parse: it is code under the truncated notice.
    ["big.json", { mime: "application/json", truncated: true }, null],
    ["csv.txt", { mime: "text/plain; charset=utf-8" }, null],
    ["0001-fix.patch", { mime: "text/x-diff" }, "patch"],
    ["changes.DIFF", {}, "patch"],
    ["from-mail", { mime: "text/x-patch" }, "patch"],
    ["diff.txt", { mime: "text/plain; charset=utf-8" }, null],
    ["blob.patch", { text: null, binary: true }, null],
    ["app.ts", { mime: "text/typescript" }, null],
    ["Makefile", {}, null],
    ["notes.txt", { mime: "text/plain; charset=utf-8" }, null],
    ["server.log", { mime: "text/plain; charset=utf-8" }, "log"],
    ["SERVER.LOG", {}, "log"],
    // Terminal output: a plain-text file with an escape sequence in it.
    ["run.txt", { text: "\u001b[32mok\u001b[0m" }, "ansi"],
    ["build.out", { text: "\u001b[1mbold" }, "ansi"],
    ["output", { text: "\u001b[31mred" }, "ansi"],
    // An ESC that starts no CSI, and code with an escape in it, stay the code view.
    ["title.txt", { text: "\u001b]0;title\u0007" }, null],
    ["colors.sh", { text: "echo \u001b[31mred" }, null],
    ["main.go", { text: "\u001b[0m" }, null],
    // A kind that cannot show the read leaves it to the code view or the binary state.
    ["blob.md", { text: null, binary: true }, null],
    ["broken.png", { mime: "image/png", text: null, binary: true }, null],
  ])("%s → %s", (path, over, want) => {
    expect(kindOf(path, over)).toBe(want);
  });

  it("before a read, only the extension counts", () => {
    expect(previewKindOf("/w/README.md", null)?.id).toBe("markdown");
    expect(previewKindOf("/w/logo.svg", null)?.id).toBe("svg");
    expect(previewKindOf("/w/logo.png", null)).toBeNull();
    expect(previewKindOf("/w/Makefile", null)).toBeNull();
    expect(previewKindOf("/w/logs/server.log", null)?.read).toBe("tail");
    expect(previewKindOf("/w/run.txt", null)).toBeNull();
  });

  it("the switch: a text kind ends with Source; an image has one mode, so no switch", () => {
    const md = previewKindOf("a.md", null);
    const svg = previewKindOf("a.svg", null);
    const png = previewKindOf("a.png", read("a.png", { mime: "image/png", image: bytes, text: null }));
    expect(md && previewModes(md, read("a.md")).map((m) => m.label)).toEqual(["Rendered", "Source"]);
    expect(svg && previewModes(svg, read("a.svg", { image: bytes })).map((m) => m.label)).toEqual(["Image", "Source"]);
    expect(png && previewModes(png, read("a.png", { image: bytes, text: null })).map((m) => m.label)).toEqual(["Image"]);
  });
});

describe("matching", () => {
  const kind = (id: string, match: PreviewKind["match"], over: Partial<PreviewKind> = {}): PreviewKind => ({ id, match, modes: [{ id: "view", label: "View" }], Body: () => null, meta: () => null, ...over });
  const tsv = kind("tsv", { ext: ["tsv"], mime: ["text/tab-separated-values"] });
  const anyText = kind("ansi", { mime: ["text/*"], sniff: (t) => t.includes("\u001b[") });
  const log = kind("log", { ext: ["log"], sniff: (t) => t.startsWith("LOG") });
  const kinds = [anyText, log, tsv];
  const of = (path: string, over: Partial<FileReadView> = {}) => previewKindOf(path, read(path, over), kinds)?.id ?? null;

  it("an extension beats an exact mime, which beats a wildcard, which beats a sniff, whatever the order", () => {
    expect(of("a.tsv", { mime: "text/plain" })).toBe("tsv");
    expect(of("a.dat", { mime: "text/tab-separated-values" })).toBe("tsv");
    expect(of("a.dat", { mime: "text/plain" })).toBe("ansi");
    expect(of("a.txt", { mime: "", text: "LOG start" })).toBe("log");
    expect(of("a.txt", { mime: "", text: "plain" })).toBeNull();
    expect(previewKindOf("a.dat", read("a.dat", { mime: "text/plain" }), [tsv, log, anyText])?.id).toBe("ansi");
  });

  it("a sniff runs on text only", () => {
    expect(of("a.bin", { mime: "", text: null, binary: true })).toBeNull();
  });

  it("a kind that cannot show the read gives way to the next match", () => {
    const picky = kind("picky", { ext: ["dat"] }, { shows: (f) => f.size > 10 });
    expect(previewKindOf("a.dat", read("a.dat", { mime: "text/plain", size: 5 }), [picky, anyText])?.id).toBe("ansi");
    expect(previewKindOf("a.dat", read("a.dat", { mime: "text/plain", size: 50 }), [picky, anyText])?.id).toBe("picky");
  });

  it("registryProblems: a shared id, extension or exact mime, a kind listing Source", () => {
    expect(registryProblems([tsv, kind("tsv", { ext: ["tab"] })])).toEqual(["id tsv is used twice"]);
    expect(registryProblems([tsv, kind("csv", { ext: ["csv", "tsv"] })])).toEqual([".tsv is claimed by tsv and csv"]);
    expect(registryProblems([tsv, kind("t2", { mime: ["text/tab-separated-values"] })])).toEqual(["text/tab-separated-values is claimed by tsv and t2"]);
    expect(registryProblems([kind("src", {}, { modes: [{ id: "x", label: "X" }, SOURCE] })])).toEqual(["src lists Source itself"]);
    // The same wildcard twice is as ambiguous (an exact type under it is fine: it wins).
    expect(registryProblems([anyText, kind("other", { mime: ["text/*"] })])).toEqual(["text/* is claimed by ansi and other"]);
  });
});

describe("pickMode", () => {
  const modes = [{ id: "rendered", label: "Rendered" }, SOURCE];

  it("the remembered mode when the switch has it, else the first", () => {
    expect(pickMode(modes, undefined)).toBe("rendered");
    expect(pickMode(modes, "source")).toBe("source");
    expect(pickMode(modes, "raw")).toBe("rendered");
    // A remembered Source on a read without text (no Source in its switch) opens the preview.
    expect(pickMode([{ id: "image", label: "Image" }], "source")).toBe("image");
  });
});
