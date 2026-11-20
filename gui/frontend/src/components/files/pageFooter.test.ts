import { describe, expect, it } from "vitest";
import type { PageAccessView } from "@/api/page";
import { pageFooterLead } from "./pageFooter";

/* What the File tab's footer leads with, per state (docs/notes/pages-tab-polish.md). */

const access = (consent: PageAccessView["consent"]): PageAccessView => ({ path: "/Users/me/p.html", ownerThread: "", ownerSource: "", owners: [], storagePerFile: true, consent, answer: consent === "owned" ? "not-asked" : consent, unavailableReason: "" });

describe("pageFooterLead", () => {
  it.each([
    ["owned by the tab's own thread", { thread: "s-1", actsFor: "", access: access("owned") }, false, { text: "Can use Code Foundry for this thread", owner: false, strong: true }],
    ["owned by another thread: named after the text", { thread: "s-2", actsFor: "s-2", access: access("owned") }, false, { text: "Can use Code Foundry for", owner: true, strong: true }],
    ["an older daemon, the tab's thread's page", { thread: "s-1", actsFor: "", access: null }, false, { text: "Can use Code Foundry for this thread", owner: false, strong: true }],
    ["an older daemon, any other file", { thread: null, actsFor: "", access: null }, false, { text: "Sandboxed from Code Foundry", owner: false, strong: false }],
    ["allowed", { thread: null, actsFor: "", access: access("allowed") }, false, { text: "Can use Code Foundry", owner: false, strong: true }],
    ["asking (the band shows)", { thread: null, actsFor: "", access: access("not-asked") }, true, { text: "Asking to use Code Foundry", owner: false, strong: true }],
    ["not asked, never said hello (a plain HTML file)", { thread: null, actsFor: "", access: access("not-asked") }, false, { text: "Sandboxed from Code Foundry", owner: false, strong: false }],
    ["refused", { thread: null, actsFor: "", access: access("refused") }, false, { text: "Not allowed to use Code Foundry", owner: false, strong: false }],
    ["a file that is no page", { thread: null, actsFor: "", access: access("unavailable") }, false, { text: "Sandboxed from Code Foundry", owner: false, strong: false }],
  ] as const)("%s", (_name, page, asking, want) => {
    expect(pageFooterLead(page, asking)).toEqual(want);
  });
});
