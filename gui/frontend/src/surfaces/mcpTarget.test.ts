import { describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import type { SessionsData } from "@/stores/sessions";
import type { Selection } from "@/stores/ui";
import { mcpTab, selectionMcpThread } from "./mcpTarget";

function session(id: string, render: "terminal" | "rendered", state = "connected"): SessionView {
  return { id, repoId: "web", worktreePath: "/src/web", render, state, linkedPullRequests: [], usage: [] } as unknown as SessionView;
}

const sessions: SessionsData = {
  byId: { "s-r": session("s-r", "rendered"), "s-off": session("s-off", "rendered", "disconnected"), "s-t": session("s-t", "terminal") },
  order: ["s-r", "s-off", "s-t"],
};
const s = { repos: { byId: {}, order: [] }, sessions };

describe("selectionMcpThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null]>([
    ["a rendered thread", { kind: "session", id: "s-r" }, "s-r"],
    ["a disconnected rendered thread", { kind: "session", id: "s-off" }, "s-off"],
    ["a terminal thread", { kind: "session", id: "s-t" }, null],
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
