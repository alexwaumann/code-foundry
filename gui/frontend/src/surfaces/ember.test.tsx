import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { EMBER_THREAD, putEmberThread, setEmberEnabled } from "@/test/emberBoard";

vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { usePanelStore } = await import("@/stores/panel");
const { useProjectsStore } = await import("@/stores/projects");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");

/** The Board surface (surfaces/ember.ts) is offered in Ember's chat's panel only, and only while Ember is on. */

const s2 = { id: "s-2", name: "Fix the sidebar", projectId: "repo-cf", workspaceId: "", worktreePath: "/src/cf", pendingWorktreePath: "", state: "connected", status: "idle", linkedPullRequests: [], usage: [], agentRuns: [] } as unknown as ThreadView;
const listed = (kind: string) => screen.queryByTestId("panel-empty")?.querySelector(`[data-surface="${kind}"]`) ?? null;

function select(id: string): void {
  act(() => {
    useUiStore.setState({ selection: { kind: "thread", id } });
  });
}

beforeEach(() => {
  setEmberEnabled(true);
  putEmberThread({}, [s2]);
  useProjectsStore.setState({ byId: {}, order: [] });
  const empty = { open: true, groups: [{ tabs: [], activeTabId: null }] };
  usePanelStore.setState({ byKey: { "thread:s-2": empty, [`thread:${EMBER_THREAD}`]: empty } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, selection: { kind: "thread", id: "s-2" } });
});

afterEach(cleanup);

describe("Board surface", () => {
  it("a thread's panel lists others, never the Board", () => {
    render(<SidePanel />);
    expect(listed("files")).not.toBeNull();
    expect(listed("ember")).toBeNull();
  });

  it("Ember's chat lists it while Ember is on", () => {
    render(<SidePanel />);
    select(EMBER_THREAD);
    expect(listed("ember")).not.toBeNull();
    act(() => {
      setEmberEnabled(false);
    });
    expect(listed("ember")).toBeNull();
  });
});
