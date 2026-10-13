import { describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import type { SessionsData } from "@/stores/sessions";
import type { Selection } from "@/stores/ui";
import { mcpTab, selectionMcpThread } from "./mcpTarget";

function session(id: string, state = "connected"): SessionView {
  return { id, repoId: "web", worktreePath: "/src/web", state, linkedPullRequests: [], usage: [] } as unknown as SessionView;
}

const sessions: SessionsData = {
  byId: { "s-r": session("s-r"), "s-off": session("s-off", "disconnected") },
  order: ["s-r", "s-off"],
};
const s = { repos: { byId: {}, order: [] }, sessions };

describe("selectionMcpThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null]>([
    ["a thread", { kind: "session", id: "s-r" }, "s-r"],
    ["a disconnected thread", { kind: "session", id: "s-off" }, "s-off"],
    ["an unknown thread", { kind: "session", id: "s-404" }, null],
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
