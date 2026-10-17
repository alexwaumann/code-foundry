import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { selectionUsageThread, usageTab } from "./usageTarget";

const WEB = "/src/web";

function thread(id: string): ThreadView {
  return { id, projectId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", terminalId: "", linkedPullRequests: [], usage: [], costUsd: 0, unpriced: false } as unknown as ThreadView;
}

const threads: ThreadsData = { byId: { "s-used": thread("s-used"), "s-new": thread("s-new") }, order: ["s-used", "s-new"] };

const s = { projects: { byId: {}, order: [] }, threads };

describe("selectionUsageThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null]>([
    ["a thread", { kind: "thread", id: "s-used" }, "s-used"],
    ["a thread without usage yet", { kind: "thread", id: "s-new" }, "s-new"],
    ["an unknown thread", { kind: "thread", id: "s-404" }, null],
    ["a composer", { kind: "compose", projectId: "web" }, null],
    ["a page", { kind: "view", name: "pullrequests" }, null],
    ["nothing", { kind: "none" }, null],
  ])("%s", (_name, sel, want) => {
    expect(selectionUsageThread(sel, s)).toBe(want);
  });

  it("has one tab per panel, without params", () => {
    expect(usageTab()).toEqual({ id: "usage", kind: "usage", title: "Usage", params: {} });
  });
});
