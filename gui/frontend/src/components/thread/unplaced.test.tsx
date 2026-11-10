import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useCollisions } from "@/components/compose/useCollisions";
import { McpSurface } from "@/components/mcp/McpSurface";
import { useFinderCheckouts } from "@/components/palette/useFileFinder";
import { TooltipProvider } from "@/components/ui/tooltip";
import { canMove } from "@/lib/move";
import { skillSources } from "@/lib/completion";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useThreadCheckouts } from "./useThreadCheckouts";
import { WaitingStrip } from "./WaitingStrip";

/**
 * A thread with no worktree yet (docs/notes/instant-threads-3-gui.md): worktreePath and its
 * checkouts are empty during its setup and after a failure. What reads them behaves.
 */

const setup = (phase: "running" | "failed") => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true });

const thread = (o: Partial<ThreadView>) =>
  ({ id: "s", name: "t", projectId: "web", projectIds: ["web"], worktreePath: "", checkoutPaths: [], createdWorktree: false, branch: "", workspaceId: "", state: "starting", status: "busy", statusReason: "setting up", archivedAtMs: null, snoozedUntilMs: null, savedAtMs: null, pendingMove: null, resident: "", flags: [], backgroundShells: [], agentRuns: [], setup: setup("running"), ...o }) as ThreadView;

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: { id: "web", name: "web", path: "/src/web", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/web", branch: "main", head: "a", isMain: true }] } } as never, order: ["web"] });
  useThreadsStore.setState({ byId: { s: thread({}) }, order: ["s"] });
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {}, order: [] });
});

describe("a thread with no checkout yet", () => {
  it("reads its projects' own checkouts for @ and /, which spawn points at its worktree", () => {
    const { result } = renderHook(() => useThreadCheckouts("s"));
    expect(result.current.paths).toEqual({ web: "/src/web" });
    expect(skillSources({ projectIds: result.current.projectIds, paths: result.current.paths })).toEqual([{ projectId: "web", path: "/src/web" }]);
  });

  it("searches them in the file finder, but lists no changes as the thread's", () => {
    const { result } = renderHook(() => useFinderCheckouts("s"));
    expect(result.current.checkouts).toEqual([{ projectId: "web", path: "/src/web" }]);
    expect(result.current.git.size).toBe(0);
  });

  it("lists changes again once it has one", () => {
    useThreadsStore.setState({ byId: { s: thread({ worktreePath: "/src/web", setup: null }) }, order: ["s"] });
    const { result } = renderHook(() => useFinderCheckouts("s"));
    expect([...result.current.git]).toEqual(["web"]);
  });

  it("collides with nobody in the composer: it holds no checkout, only resolves one", () => {
    const mine = () => ({ checkouts: [{ projectId: "web", path: "/src/web" }], worktreeMode: false });
    expect(renderHook(() => useCollisions(mine)).result.current).toEqual([]);
    useThreadsStore.setState({ byId: { s: thread({ worktreePath: "/src/web", setup: null }) }, order: ["s"] });
    expect(renderHook(() => useCollisions(mine)).result.current).toHaveLength(1);
  });

  it("does not offer a move: the daemon refuses one until its setup finished", () => {
    const home = thread({ projectId: "", projectIds: [], worktreePath: "/Users/dev" });
    expect(canMove(home, useProjectsStore.getState())).toBe(false);
    expect(canMove({ ...home, setup: null }, useProjectsStore.getState())).toBe(true);
  });

  it("says when MCP servers will show, with no Refresh the daemon would refuse", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s" } });
    const { getByTestId, queryByTestId } = render(
      <TooltipProvider>
        <McpSurface />
      </TooltipProvider>,
    );
    expect(getByTestId("mcp-unstarted").textContent).toBe("MCP servers show here once Claude has started.");
    expect(queryByTestId("mcp-refresh")).toBeNull();
  });

  it.each<[string, Partial<ThreadView>]>([
    ["failed", { state: "disconnected", status: "error", statusReason: "setup failed", setup: setup("failed") }],
    ["running", {}],
  ])("shows nothing in the waiting strip: %s", (_n, o) => {
    useThreadsStore.setState({ byId: { s: thread(o) }, order: ["s"] });
    const { container } = render(
      <TooltipProvider>
        <WaitingStrip threadId="s" />
      </TooltipProvider>,
    );
    expect(container.textContent).toBe("");
  });
});
