import { describe, expect, it } from "vitest";
import { GALLERY_KIND, galleryTab, imageKey, imageLabel, imageName, parseGalleryImages } from "./galleryTarget";

const images = JSON.stringify([{ path: "/tmp/a.png", caption: "Before", stamp: 5 }, { path: "/tmp/b.png" }]);

describe("galleryTab", () => {
  it("keys the tab by its title alone, so a new list of images finds it", () => {
    const one = galleryTab({ title: "Shots", images, project: "p", base: "/wt" });
    const other = galleryTab({ title: "Shots", images: JSON.stringify([{ path: "/tmp/c.png" }]), project: "", base: "" });
    expect(one).toMatchObject({ kind: GALLERY_KIND, title: "Shots", params: { title: "Shots", images, project: "p", base: "/wt" } });
    expect(other?.id).toBe(one?.id);
    expect(galleryTab({ title: "Others", images })?.id).not.toBe(one?.id);
  });

  it.each([
    ["no title", { images }],
    ["no images", { title: "Shots" }],
    ["an empty list", { title: "Shots", images: "[]" }],
    ["bad JSON", { title: "Shots", images: "{" }],
  ])("opens nothing for %s", (_name, params) => {
    expect(galleryTab(params)).toBeNull();
  });
});

describe("parseGalleryImages", () => {
  it("takes what is an image and cleans a caption, as model text", () => {
    const list = JSON.stringify([{ path: "/a.png", caption: "two\nlines\u202e", stamp: 7 }, { caption: "no path" }, 3, null, { path: 4 }, { path: "/b.png", caption: 9, stamp: "x" }]);
    expect(parseGalleryImages(list)).toEqual([
      { path: "/a.png", caption: "two lines", stamp: 7 },
      { path: "/b.png", caption: "", stamp: 0 },
    ]);
  });

  it.each(["", "{", "{}", "null"])("is empty for %j", (raw) => {
    expect(parseGalleryImages(raw)).toEqual([]);
  });
});

describe("what names an image", () => {
  const captioned = { path: "/tmp/shots/a.png", caption: "Before", stamp: 1 };
  const bare = { path: "/tmp/shots/b.png", caption: "", stamp: 0 };

  it("is its caption, else its file's name", () => {
    expect(imageLabel(captioned)).toBe("Before");
    expect(imageLabel(bare)).toBe("b.png");
    expect(imageName(captioned)).toBe("a.png");
  });

  it("gives a file rewritten at its path a new key", () => {
    expect(imageKey(captioned)).not.toBe(imageKey({ ...captioned, stamp: 2 }));
    expect(imageKey(captioned)).toBe(imageKey({ ...captioned, caption: "After" }));
  });
});
