import { describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";
import type { SessionsData } from "@/stores/sessions";
import type { TerminalsData } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";
import { selectionUsageThread, usageTab } from "./usageTarget";

const WEB = "/src/web";

function session(id: string): SessionView {
  return { id, repoId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", terminalId: "", linkedPullRequests: [], usage: [], costUsd: 0, unpriced: false } as unknown as SessionView;
}

const sessions: SessionsData = { byId: { "s-used": session("s-used"), "s-new": session("s-new") }, order: ["s-used", "s-new"] };

const terminals: TerminalsData = {
  byId: {
    "t-used": { id: "t-used", cwd: WEB, labels: { session: "s-used" } } as unknown as TerminalView,
    "t-plain": { id: "t-plain", cwd: WEB, labels: {} } as unknown as TerminalView,
    "t-gone": { id: "t-gone", cwd: WEB, labels: { session: "s-404" } } as unknown as TerminalView,
  },
  order: [],
};

const s = { repos: { byId: {}, order: [] }, sessions, terminals };

describe("selectionUsageThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null]>([
    ["a thread", { kind: "session", id: "s-used" }, "s-used"],
    ["a thread without usage yet", { kind: "session", id: "s-new" }, "s-new"],
    ["a thread's terminal", { kind: "terminal", id: "t-used" }, "s-used"],
    ["a plain terminal", { kind: "terminal", id: "t-plain" }, null],
    ["a terminal of an unknown thread", { kind: "terminal", id: "t-gone" }, null],
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
