import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { AgentRunUsageView as ListedRun } from "@/api/threads";
import { resetDaemon } from "@/test/daemonFakes";
import { bucket, resetCard, seedSingle, seedWs9, setLog, updateThread } from "@/test/threadInfoWorld";
import { useProjectsStore } from "@/stores/projects";
import { useSubagentViewStore } from "@/stores/subagentView";
import { ThreadInfoContent } from "./ThreadInfoCard";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/cardFakes")).cardGhFakes }));
vi.mock("@/api/actions", async (orig) => ({ ...(await orig<typeof import("@/api/actions")>()), ...(await import("@/test/cardFakes")).cardActionFakes }));
vi.mock("@/api/gitops", async (orig) => ({ ...(await orig<typeof import("@/api/gitops")>()), ...(await import("@/test/cardFakes")).cardGitopsFakes }));
vi.mock("@/api/placement", async (orig) => ({ ...(await orig<typeof import("@/api/placement")>()), ...(await import("@/test/cardFakes")).cardPlacementFakes }));

/**
 * A subagent's card (ThreadInfoContent with a runId; docs/notes/subagent-as-thread.md): the
 * thread's facts and ways to look, the run's own lineage, context and cost, and nothing
 * that acts on the thread.
 */

const NOW = Date.now();

function live(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: `toolu_${id}`,
    parentId: "",
    description: id,
    agentType: "Explore",
    model: "opus",
    effort: "",
    background: true,
    spawnDepth: 1,
    status: "running",
    activity: "",
    totalTokens: 48_200,
    toolUses: 3,
    durationMs: 0,
    summary: "",
    error: "",
    startedAtMs: NOW - 40_000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const listed = (id: string, o: Partial<ListedRun>): ListedRun => ({ id, description: id, agentType: "Explore", model: "opus", effort: "", background: true, status: "open", spawnDepth: 1, startedAtMs: null, usage: [], costUsd: 0, unpriced: false, ...o });

const tid = (id: string) => screen.getByTestId(id);
const none = (...ids: string[]) => {
  for (const id of ids) expect(screen.queryByTestId(id), id).toBeNull();
};

let threadId = "";

beforeEach(() => {
  resetDaemon();
  resetCard();
  threadId = seedSingle();
  setLog(threadId, { agents: [live("a1"), live("a2", { status: "done" }), live("n1", { parentId: "a1", spawnDepth: 2, description: "Review" }), live("n2", { parentId: "a1", spawnDepth: 2, status: "done", description: "Scan" }), live("n9", { parentId: "a2", spawnDepth: 2, description: "Other" })] });
  updateThread(threadId, { contextWindow: 1_000_000, contextTokens: 400_000, name: "Agents panel" });
  useSubagentViewStore.setState({ viewing: { threadId, runId: "a1" } });
});

afterEach(() => {
  cleanup();
  useSubagentViewStore.setState({ viewing: null });
});

const card = (runId = "a1") => render(<ThreadInfoContent threadId={threadId} runId={runId} />);

describe("a subagent's card", () => {
  it("has the place and git facts, but nothing that acts on the thread", () => {
    card();
    expect(tid("thread-info-card").hasAttribute("data-read-only")).toBe(true);
    expect(tid("ti-project").textContent).toContain("Fresh copy");
    expect(tid("ti-project").getAttribute("role")).toBeNull();
    expect(tid("ti-project").getAttribute("aria-haspopup")).toBeNull();
    expect(tid("ti-open-in").textContent).toContain("Open in Finder");
    expect(tid("ti-branch")).toBeTruthy();
    none("ti-project-menu", "ti-add-project", "ti-action", "ti-add-action-row", "ti-git", "ti-shells-group", "ti-mcp-group", "ti-lineage-stop");
  });

  it("drops the git state row a thread's card shows for the same checkout", () => {
    useProjectsStore.setState((st) => {
      const p = Object.values(st.byId).find((x) => x.worktrees.length > 0);
      if (!p) return st;
      const worktrees = p.worktrees.map((w) => ({ ...w, status: { ...w.status, upstream: "origin/main", ahead: 2, behind: 0 } }));
      return { byId: { ...st.byId, [p.id]: { ...p, worktrees } } };
    });
    const { unmount } = render(<ThreadInfoContent threadId={threadId} />);
    expect(tid("ti-git").getAttribute("data-kind")).toBe("push");
    unmount();
    card();
    none("ti-git");
    expect(tid("ti-branch-ahead").textContent).toBe("2");
  });

  it("an unnamed set's project row keeps its +N, with no menu", () => {
    const ws = seedWs9();
    updateThread(ws, { workspaceId: "" });
    setLog(ws, { agents: [live("a1")] });
    render(<ThreadInfoContent threadId={ws} runId="a1" />);
    expect(tid("ti-project").getAttribute("aria-haspopup")).toBeNull();
    none("ti-runin-item", "ti-save-workspace", "ti-use-workspace");
  });

  it("Lineage: the thread with its state, then this run's own runs; another run's are not listed", () => {
    card();
    expect(tid("ti-lineage-label").textContent).toBe("Lineage · 1 running");
    expect(tid("ti-parent").textContent).toContain("Agents panel");
    const rows = screen.getAllByTestId("ti-lineage-row").map((r) => r.getAttribute("data-id"));
    expect(rows).toEqual(["n1"]);
    fireEvent.click(tid("ti-previous"));
    expect(screen.getAllByTestId("ti-lineage-row").map((r) => r.getAttribute("data-id"))).toEqual(["n1", "n2"]);
  });

  it("a run's own runs open nothing (depth 2 has no view)", () => {
    card();
    const row = screen.getAllByTestId("ti-lineage-row")[0] as HTMLElement;
    expect(row.getAttribute("role")).toBeNull();
    fireEvent.click(row);
    expect(useSubagentViewStore.getState().viewing?.runId).toBe("a1");
  });

  it("the parent row goes back up", () => {
    card();
    fireEvent.click(tid("ti-parent"));
    expect(useSubagentViewStore.getState().viewing).toBeNull();
  });

  it("a run with no runs of its own: the label and the parent only", () => {
    setLog(threadId, { agents: [live("a1")] });
    card();
    expect(tid("ti-lineage-label").textContent).toBe("Lineage");
    expect(tid("ti-parent").textContent).toContain("Agents panel");
    none("ti-lineage-row", "ti-previous");
  });

  it("no Compact row: the thread's context past the threshold is the thread's card's to offer", () => {
    updateThread(threadId, { state: "connected", status: "idle", statusReason: "at prompt", contextTokens: 412_000 });
    const { unmount } = render(<ThreadInfoContent threadId={threadId} />);
    expect(screen.getByTestId("ti-compact")).toBeTruthy();
    unmount();
    card();
    expect(screen.queryByTestId("ti-compact")).toBeNull();
  });

  it("Context is the run's tokens against the window, with no cache words", () => {
    updateThread(threadId, { cacheExpiresAtMs: NOW + 30 * 60_000 });
    card();
    expect(tid("ti-context-tokens").textContent).toBe("48.2K of 1M");
    expect(tid("ti-context-label").textContent).toBe("Context");
    none("ti-context-cache");
  });

  it("Usage is the run's own cost, matched by id, not the thread's", () => {
    updateThread(threadId, {
      usage: [bucket("claude-opus-4-8", { costUsd: 12 })],
      agentRuns: [listed("a2", { usage: [bucket("claude-opus-4-8", { costUsd: 3 })] }), listed("a1", { usage: [bucket("claude-opus-4-8", { costUsd: 0.84 })] })],
    });
    card();
    expect(tid("ti-usage-meta").textContent).toBe("$0.84");
  });

  it("follows the run's usage as it grows", () => {
    updateThread(threadId, { agentRuns: [listed("a1", { usage: [bucket("claude-opus-4-8", { costUsd: 0.84 })] })] });
    card();
    act(() => {
      updateThread(threadId, { agentRuns: [listed("a1", { usage: [bucket("claude-opus-4-8", { costUsd: 1.1 })] })] });
    });
    expect(tid("ti-usage-meta").textContent).toBe("$1.10");
  });

  it("an unpriced run says so, as a thread does", () => {
    updateThread(threadId, { agentRuns: [listed("a1", { usage: [bucket("claude-next", { costUsd: 0, unpriced: true })], unpriced: true })] });
    card();
    expect(tid("ti-usage-meta").textContent).toBe("unpriced");
  });

  it("a run with no usage yet shows what a thread's card shows for nothing", () => {
    updateThread(threadId, { usage: [] });
    const { unmount } = render(<ThreadInfoContent threadId={threadId} />);
    const nothing = tid("ti-usage-meta").textContent;
    unmount();
    card();
    expect(tid("ti-usage-meta").textContent).toBe(nothing);
  });

  it("a run the list does not have yet (the live run came first) shows the same", () => {
    updateThread(threadId, { usage: [], agentRuns: [listed("other", { usage: [bucket("claude-opus-4-8", { costUsd: 5 })] })] });
    const { unmount } = render(<ThreadInfoContent threadId={threadId} />);
    const nothing = tid("ti-usage-meta").textContent;
    unmount();
    card();
    expect(tid("ti-usage-meta").textContent).toBe(nothing);
  });
});
