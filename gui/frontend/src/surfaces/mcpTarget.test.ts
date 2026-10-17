import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { mcpTab, selectionMcpThread } from "./mcpTarget";

function thread(id: string, state = "connected"): ThreadView {
  return { id, repoId: "web", worktreePath: "/src/web", state, linkedPullRequests: [], usage: [] } as unknown as ThreadView;
}

const threads: ThreadsData = {
  byId: { "s-r": thread("s-r"), "s-off": thread("s-off", "disconnected") },
  order: ["s-r", "s-off"],
};
const s = { repos: { byId: {}, order: [] }, threads };

describe("selectionMcpThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null]>([
    ["a thread", { kind: "thread", id: "s-r" }, "s-r"],
    ["a disconnected thread", { kind: "thread", id: "s-off" }, "s-off"],
    ["an unknown thread", { kind: "thread", id: "s-404" }, null],
    ["a composer", { kind: "compose", repoId: "web" }, null],
    ["a page", { kind: "view", name: "pullrequests" }, null],
    ["nothing", { kind: "none" }, null],
  ])("%s", (_name, sel, want) => {
    expect(selectionMcpThread(sel, s)).toBe(want);
  });

  it("has one tab per panel, without params", () => {
    expect(mcpTab()).toEqual({ id: "mcp", kind: "mcp", title: "MCP", params: {} });
  });
});
