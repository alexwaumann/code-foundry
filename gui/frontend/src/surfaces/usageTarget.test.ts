import { describe, expect, it } from "vitest";
import type { SessionView } from "@/api/threads";
import type { SessionsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { selectionUsageThread, usageTab } from "./usageTarget";

const WEB = "/src/web";

function session(id: string): SessionView {
  return { id, repoId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", terminalId: "", linkedPullRequests: [], usage: [], costUsd: 0, unpriced: false } as unknown as SessionView;
}

const sessions: SessionsData = { byId: { "s-used": session("s-used"), "s-new": session("s-new") }, order: ["s-used", "s-new"] };

const s = { repos: { byId: {}, order: [] }, sessions };

describe("selectionUsageThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null]>([
    ["a thread", { kind: "session", id: "s-used" }, "s-used"],
    ["a thread without usage yet", { kind: "session", id: "s-new" }, "s-new"],
    ["an unknown thread", { kind: "session", id: "s-404" }, null],
    ["a composer", { kind: "compose", repoId: "web" }, null],
    ["a page", { kind: "view", name: "pullrequests" }, null],
    ["nothing", { kind: "none" }, null],
  ])("%s", (_name, sel, want) => {
    expect(selectionUsageThread(sel, s)).toBe(want);
  });

  it("has one tab per panel, without params", () => {
    expect(usageTab()).toEqual({ id: "usage", kind: "usage", title: "Usage", params: {} });
  });
});
