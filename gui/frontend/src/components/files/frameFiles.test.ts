import { describe, expect, it } from "vitest";
import { frameReport, grantFiles } from "./frameFiles";

describe("frameReport", () => {
  it.each([
    ["an answer to a ping", { type: "cf:here", seq: 1, files: ["/preview/g/a.html", 3, "rel.css", "/cf/theme.css"], theme: true }, { files: ["/preview/g/a.html", "/cf/theme.css"], theme: true }],
    ["files fetched after the load", { type: "cf:files", files: ["/preview/g/x.json"] }, { files: ["/preview/g/x.json"], theme: false }],
    ["an older script's answer, with no list", { type: "cf:here", seq: 1 }, null],
    ["another message", { type: "cf:going", files: [] }, null],
    ["not an object", "cf:here", null],
  ])("reads %s", (_name, data, want) => {
    expect(frameReport(data)).toEqual(want);
  });

  it("takes at most 64 paths", () => {
    expect(frameReport({ type: "cf:files", files: Array.from({ length: 80 }, (_, i) => `/p/${String(i)}`) })?.files).toHaveLength(64);
  });
});

describe("grantFiles", () => {
  const PAGE = "http://127.0.0.1:9/preview/g1/docs/index.html";
  it.each([
    ["a stylesheet beside the page", ["/preview/g1/docs/style.css"], ["/s/docs/style.css"]],
    ["an escaped name", ["/preview/g1/a%20b/%23x.js"], ["/s/a b/#x.js"]],
    ["a folder, as its index", ["/preview/g1/sub/"], ["/s/sub/index.html"]],
    ["the page itself, its host's to watch", ["/preview/g1/docs/index.html"], []],
    ["another grant, the app's routes and the root", ["/preview/g2/docs/style.css", "/cf/theme.css", "/x.css"], []],
    ["a path that does not decode or climbs", ["/preview/g1/%E0%A4%A", "/preview/g1/a/%2F/b", "/preview/g1/..%2Fx"], []],
    ["repeats, sorted", ["/preview/g1/b.js", "/preview/g1/a.js", "/preview/g1/b.js"], ["/s/a.js", "/s/b.js"]],
  ])("maps %s", (_name, paths, want) => {
    expect(grantFiles(PAGE, "/s", paths)).toEqual(want);
  });

  const HOST_PAGE = "http://0123456789abcdef0123456789abcdef.localhost:9/docs/index.html";
  it.each([
    ["a root-absolute stylesheet", ["/assets/index.css"], ["/s/assets/index.css"]],
    ["a folder, as its index", ["/sub/"], ["/s/sub/index.html"]],
    ["the page itself, its host's to watch", ["/docs/index.html"], []],
    ["a cf/ path, which the folder may have", ["/cf/theme.css"], ["/s/cf/theme.css"]],
    ["a path like another grant's, which is this one's own", ["/preview/g2/x.css"], ["/s/preview/g2/x.css"]],
    ["a path that does not decode or climbs", ["/%E0%A4%A", "/a/%2F/b", "/..%2Fx"], []],
  ])("maps on the grant's own host %s", (_name, paths, want) => {
    expect(grantFiles(HOST_PAGE, "/s", paths)).toEqual(want);
  });

  it("maps nothing for a page URL without a grant, or no scope", () => {
    expect(grantFiles("http://not-a-grant.localhost:9/page.html", "/s", ["/x.css"])).toEqual([]);
    expect(grantFiles("http://127.0.0.1:9/page.html", "/s", ["/x.css"])).toEqual([]);
    expect(grantFiles(PAGE, "", ["/preview/g1/x.css"])).toEqual([]);
    expect(grantFiles("not a url", "/s", ["/preview/g1/x.css"])).toEqual([]);
  });
});
