import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { toEventView } from "@/api/events";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { applyPageEvent, pageAnswered, pageChanges, usePageAnswers } from "./pageAnswers";

afterEach(() => {
  usePageAnswers.setState({ byPath: {}, byThread: {}, all: 0 });
});

const count = (path: string, owner = "") => pageChanges(usePageAnswers.getState(), path, owner ? [owner] : []);

describe("pageAnswers: what makes a page's grant be read again", () => {
  it.each([
    ["its path named", { paths: ["/a.html"], removedThread: "", all: false }, 1, 0],
    ["another path", { paths: ["/b.html"], removedThread: "", all: false }, 0, 0],
    ["its owner removed", { paths: [], removedThread: "s-1", all: false }, 1, 0],
    ["another thread removed", { paths: [], removedThread: "s-2", all: false }, 0, 0],
    ["every page", { paths: [], removedThread: "", all: true }, 1, 1],
  ])("%s", (_name, ev, owned, unowned) => {
    const [ownedBefore, unownedBefore] = [count("/a.html", "s-1"), count("/a.html")];
    applyPageEvent(ev);
    expect(count("/a.html", "s-1") - ownedBefore).toBe(owned);
    expect(count("/a.html") - unownedBefore).toBe(unowned + (ev.paths.includes("/a.html") ? 1 : 0));
  });

  it("any owner's removal counts for a page many threads own", () => {
    const owners = () => pageChanges(usePageAnswers.getState(), "/a.html", ["s-1", "s-2"]);
    applyPageEvent({ paths: [], removedThread: "s-2", all: false });
    expect(owners()).toBe(1);
    applyPageEvent({ paths: [], removedThread: "s-3", all: false });
    expect(owners()).toBe(1);
  });

  it("an answer in this window counts at once", () => {
    pageAnswered("/a.html");
    expect(count("/a.html")).toBe(1);
  });

  it("the daemon's page event maps to the page source", () => {
    const ev = create(EventSchema, { event: { case: "page", value: { paths: ["/a.html"], removedThread: "s-1", all: true } } });
    expect(toEventView(ev)).toEqual({ source: "page", event: { paths: ["/a.html"], removedThread: "s-1", all: true } });
  });
});
