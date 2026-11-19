import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PageAccessSchema, PageConsent, PageOwnerSource } from "@/gen/codefoundry/v1/page_pb";
import { pageAccessFromJson, toPageAccessView } from "./page";

// A page's owners and where its storage is (docs/notes/page-storage-per-file.md), as the GUI
// reads them from the daemon, and from a daemon that keeps one owner and no storage per file.
describe("toPageAccessView: owners and storage", () => {
  it.each([
    [
      "every owner, the first first, and storage per file",
      { ownerThread: "s-1", ownerSource: PageOwnerSource.PAGES_DIRECTORY, owners: [{ threadId: "s-1", source: PageOwnerSource.PAGES_DIRECTORY }, { threadId: "s-2", source: PageOwnerSource.WRITTEN }], storagePerFile: true },
      { ownerThread: "s-1", owners: [{ thread: "s-1", source: "pages-directory" }, { thread: "s-2", source: "written" }], storagePerFile: true },
    ],
    ["an older daemon: its one owner, the thread's own storage", { ownerThread: "s-1", ownerSource: PageOwnerSource.SHOWN }, { ownerThread: "s-1", owners: [{ thread: "s-1", source: "shown" }], storagePerFile: false }],
    ["no owner", { storagePerFile: true }, { ownerThread: "", owners: [], storagePerFile: true }],
  ])("%s", (_name, over, want) => {
    const p = create(PageAccessSchema, { path: "/h/a.html", consent: "ownerThread" in over ? PageConsent.OWNED : PageConsent.ALLOWED, answer: PageConsent.NOT_ASKED, ...over });
    expect(toPageAccessView(p)).toMatchObject(want);
  });
});

describe("pageAccessFromJson: the page commands' owners", () => {
  it.each([
    ["many owners", { owners: [{ thread: "s-1", source: "written" }, { thread: "s-2", source: "shown" }] }, [{ thread: "s-1", source: "written" }, { thread: "s-2", source: "shown" }]],
    ["an older daemon's JSON: the owner alone", {}, [{ thread: "s-1", source: "written" }]],
    ["junk owners are left out", { owners: [{ thread: "", source: "shown" }, { thread: "s-3", source: "nope" }, "x"] }, [{ thread: "s-1", source: "written" }]],
  ])("%s", (_name, over, owners) => {
    const v = pageAccessFromJson(JSON.stringify({ path: "/h/a.html", owner_thread: "s-1", owner_source: "written", consent: "owned", answer: "not-asked", ...over }));
    expect(v?.owners).toEqual(owners);
  });
});
