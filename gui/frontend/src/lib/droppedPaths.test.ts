import { describe, expect, it } from "vitest";
import { pathAsText, pathsAsText, spacedAtCaret, splitDroppedPaths } from "./droppedPaths";

describe("splitDroppedPaths", () => {
  it.each([
    { name: "nothing", paths: [], attach: [], insert: [] },
    { name: "the five kinds", paths: ["/a/x.png", "/a/x.jpg", "/a/x.jpeg", "/a/x.gif", "/a/x.webp", "/a/x.pdf"], attach: ["/a/x.png", "/a/x.jpg", "/a/x.jpeg", "/a/x.gif", "/a/x.webp", "/a/x.pdf"], insert: [] },
    { name: "any case", paths: ["/a/X.PNG", "/a/Doc.Pdf", "/a/y.JpEg"], attach: ["/a/X.PNG", "/a/Doc.Pdf", "/a/y.JpEg"], insert: [] },
    { name: "other files", paths: ["/a/notes.txt", "/a/x.svg", "/a/x.heic", "/a/x.tiff", "/a/main.go"], attach: [], insert: ["/a/notes.txt", "/a/x.svg", "/a/x.heic", "/a/x.tiff", "/a/main.go"] },
    { name: "folders and no extension", paths: ["/Users/me/src", "/Users/me/Makefile", "/a/dir.png/"], attach: [], insert: ["/Users/me/src", "/Users/me/Makefile", "/a/dir.png/"] },
    { name: "extension only in a parent", paths: ["/a/b.png/c"], attach: [], insert: ["/a/b.png/c"] },
    { name: "a bare extension is no name", paths: ["/a/.png"], attach: [], insert: ["/a/.png"] },
    { name: "near misses", paths: ["/a/x.pngx", "/a/x.jpe", "/a/xpng", "/a/x.pdf.txt"], attach: [], insert: ["/a/x.pngx", "/a/x.jpe", "/a/xpng", "/a/x.pdf.txt"] },
    { name: "mixed keeps order", paths: ["/a/1.txt", "/a/2.png", "/a/3", "/a/4.pdf"], attach: ["/a/2.png", "/a/4.pdf"], insert: ["/a/1.txt", "/a/3"] },
    { name: "spaces in names", paths: ["/a/red square.png", "/a/my notes.md"], attach: ["/a/red square.png"], insert: ["/a/my notes.md"] },
  ])("$name", ({ paths, attach, insert }) => {
    expect(splitDroppedPaths(paths)).toEqual({ attach, insert });
  });
});

describe("pathAsText", () => {
  it.each([
    { path: "/Users/me/src/app/main.go", want: "/Users/me/src/app/main.go" },
    { path: "/Users/me/a-b_c.d+e@f%g=h:i,j", want: "/Users/me/a-b_c.d+e@f%g=h:i,j" },
    { path: "/Users/me/my notes.txt", want: '"/Users/me/my notes.txt"' },
    { path: "/a/tab\there", want: '"/a/tab\there"' },
    { path: "/a/it's.txt", want: "\"/a/it's.txt\"" },
    { path: "/a/(draft) [1] {x}.txt", want: '"/a/(draft) [1] {x}.txt"' },
    { path: "/a/a&b;c|d*e?f!g#h~i<j>.txt", want: '"/a/a&b;c|d*e?f!g#h~i<j>.txt"' },
    { path: '/a/say "hi".txt', want: '"/a/say \\"hi\\".txt"' },
    { path: "/a/back\\slash", want: '"/a/back\\\\slash"' },
    { path: "/a/$HOME", want: '"/a/\\$HOME"' },
    { path: "/a/`cmd`", want: '"/a/\\`cmd\\`"' },
    { path: "/a/Café.txt", want: '"/a/Café.txt"' },
    { path: "/a/Screenshot at 10.00 AM.txt", want: '"/a/Screenshot at 10.00 AM.txt"' },
  ])("$path", ({ path, want }) => {
    expect(pathAsText(path)).toBe(want);
  });
});

describe("pathsAsText", () => {
  it.each([
    { paths: [], want: "" },
    { paths: ["/a/x.txt"], want: "/a/x.txt" },
    { paths: ["/a/x.txt", "/a/y z.txt", "/b"], want: '/a/x.txt "/a/y z.txt" /b' },
  ])("$want", ({ paths, want }) => {
    expect(pathsAsText(paths)).toBe(want);
  });
});

describe("spacedAtCaret", () => {
  it.each([
    { name: "empty line", before: "", after: "", want: "/p" },
    { name: "after a word", before: "see", after: "", want: " /p" },
    { name: "after a space", before: "see ", after: "", want: "/p" },
    { name: "before a word", before: "", after: "now", want: "/p " },
    { name: "before a space", before: "", after: " now", want: "/p" },
    { name: "mid word", before: "ab", after: "cd", want: " /p " },
    { name: "between spaces", before: "a ", after: " b", want: "/p" },
    { name: "after a tab", before: "a\t", after: "", want: "/p" },
    { name: "after a chip (leaf char)", before: "x￼", after: "", want: " /p" },
  ])("$name", ({ before, after, want }) => {
    expect(spacedAtCaret("/p", before, after)).toBe(want);
  });
});
