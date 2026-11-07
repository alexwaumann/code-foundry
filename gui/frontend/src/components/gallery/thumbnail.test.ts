import { describe, expect, it } from "vitest";
import { blankFile, type FileReadView } from "@/api/files";
import { imageFailure, thumbMime, thumbSize } from "./thumbnail";

const png: FileReadView = { ...blankFile("/a.png"), text: null, binary: true, mime: "image/png", image: new Uint8Array([1]) };

describe("imageFailure", () => {
  it.each<[string, Partial<FileReadView>, string | null]>([
    ["an image", {}, null],
    ["a missing file", { notFound: true, image: null }, "Not found"],
    ["a folder", { isDir: true, image: null }, "A folder"],
    ["anything else", { mime: "text/plain", image: null }, "Not an image"],
    ["an image cut short by the read cap", { truncated: true }, "Too large"],
  ])("%s", (_name, change, want) => {
    expect(imageFailure({ ...png, ...change })).toBe(want);
  });
});

describe("thumbSize", () => {
  it.each([
    [2880, 1800, { width: 640, height: 400 }],
    [1800, 2880, { width: 400, height: 640 }],
    [6000, 3, { width: 640, height: 1 }],
    [641, 641, { width: 640, height: 640 }],
  ])("shrinks %d by %d to its longest side", (w, h, want) => {
    expect(thumbSize(w, h, 640)).toEqual(want);
  });

  it.each([
    [640, 400],
    [12, 12],
    [0, 0],
  ])("leaves %d by %d as it is", (w, h) => {
    expect(thumbSize(w, h, 640)).toBeNull();
  });
});

describe("thumbMime", () => {
  it.each([
    ["image/jpeg", "image/jpeg"],
    ["image/png", "image/png"],
    ["image/webp", "image/png"],
    ["image/gif", "image/png"],
  ])("%s is kept as %s", (mime, want) => {
    expect(thumbMime(mime)).toBe(want);
  });
});
