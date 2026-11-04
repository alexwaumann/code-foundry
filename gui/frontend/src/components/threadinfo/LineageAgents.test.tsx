import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { addWorkspace, CF, FEAT, HOME, seedWorld, thread, WR } = await import("@/test/projectsWorld");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { LineageGroup } = await import("./LineageGroup");

/**
 * The thread info card's agent rows (LineageGroup) over the mock's "agents" s-r1
 * (mock/agents.ts): a click opens the run (thread.agent.open); the finished ones fold under
 * Previous agents. What the run's view shows: src/components/thread/SubagentPane.test.tsx.
 */

const NOW = Date.now();

function run(id: string, description: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: `toolu_${id}`,
    parentId: "",
    description,
    agentType: "general-purpose",
    model: "opus",
    effort: "high",
    background: true,
    spawnDepth: 1,
    status: "running",
    activity: "",
    lastTool: "",
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    summary: "",
    error: "",
    startedAtMs: NOW - 240_000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const RUNS = [
  run("a0", "Find the header chip pattern", { agentType: "Explore", model: "haiku", background: false, status: "done", endedAtMs: NOW - 318_000 }),
  run("a1", "PR 1: daemon task frames"),
  run("a2", "PR 2: Agents surface in the panel"),
  run("a3", "Screenshot the panel in Wails", { status: "failed", error: "Stopped: process exited with code 1", endedAtMs: NOW - 183_000 }),
];

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="ti-lineage-row"][data-kind="agent"][data-id="${id}"]`);

beforeEach(() => {
  resetDaemon();
  useThreadsStore.setState({ byId: { "s-r1": thread("s-r1", { name: "Agents panel", state: "connected" }) }, order: ["s-r1"] });
  useThreadStore.setState({ logs: { "s-r1": { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: RUNS } } });
});

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {} });
});

describe("the card's agent rows", () => {
  it("a running run's row opens it; the finished ones are under Previous agents, and open too", () => {
    render(<LineageGroup threadId="s-r1" />);
    expect(row("a0")).toBeNull();
    fireEvent.click(row("a2") as HTMLElement);
    expect(invocationsOf("thread.agent.open").map((i) => i.args)).toEqual([{ id: "s-r1", run: "a2" }]);
    fireEvent.click(screen.getByTestId("ti-previous"));
    fireEvent.click(row("a0") as HTMLElement);
    expect(invocationsOf("thread.agent.open").map((i) => i.args).at(-1)).toEqual({ id: "s-r1", run: "a0" });
  });
});

describe("the hover card's place", () => {
  const anyRow = (id: string) => document.querySelector<HTMLElement>(`[data-testid="ti-lineage-row"][data-id="${id}"]`) as HTMLElement;

  /** The row's card, opened as keyboard navigation would. */
  function open(id: string): HTMLElement {
    const el = anyRow(id);
    fireEvent.keyDown(document, { key: "Tab" });
    act(() => {
      el.focus();
    });
    return screen.getByRole("tooltip");
  }

  /** The place rows in order: test id (without "tip-"), then the text with its meta or chip. */
  const place = (card: HTMLElement) =>
    [...within(card).getByTestId("ti-lineage-place").children].map((r) => [(r as HTMLElement).dataset.testid?.replace("tip-", ""), r.textContent]);

  /** A lead with one child thread "c" in the given place, and no runs. */
  function child(o: Partial<ThreadView>): void {
    const lead = thread("lead", { state: "connected" });
    const c = thread("c", { name: "Child", createdBy: "lead", state: "connected", status: "busy", ...o });
    useThreadsStore.setState({ byId: { lead, c }, order: ["lead", "c"] });
    useThreadStore.setState({ logs: {} });
    render(<LineageGroup threadId="lead" />);
  }

  beforeEach(seedWorld);

  it.each<[string, Partial<ThreadView>, (string | undefined)[][]]>([
    ["a fresh copy: project with its meta, then the branch", { worktreePath: FEAT, createdWorktree: true }, [["project", "code-foundryFresh copy"], ["branch", "feat/sidebar"]]],
    ["the project's folder: no branch", { worktreePath: CF }, [["project", "code-foundryProject folder"]]],
    ["a worktree the user picked: no meta, but the branch", { worktreePath: FEAT }, [["project", "code-foundry"], ["branch", "feat/sidebar"]]],
    ["a project without git: the chip, no branch", { projectId: "repo-wr", worktreePath: WR }, [["project", "writingno git"]]],
    ["no project: the name alone", { projectId: "", projectIds: [], worktreePath: HOME }, [["project", "No project"]]],
    ["several projects with no workspace: their count, then the project", { worktreePath: FEAT, createdWorktree: true, projectIds: ["repo-cf", "repo-gp"] }, [["workspace", "2 projects"], ["project", "code-foundryFresh copy"], ["branch", "feat/sidebar"]]],
  ])("a child thread in %s", (_name, o, want) => {
    child(o);
    expect(place(open("c"))).toEqual(want);
  });

  it("a workspace comes first with its project count, then the project, then the branch", () => {
    const ws = addWorkspace("Platform", ["repo-cf", "repo-gp", "repo-dot"]);
    child({ worktreePath: FEAT, createdWorktree: true, workspaceId: ws.id, projectIds: ["repo-cf", "repo-gp", "repo-dot"] });
    expect(place(open("c"))).toEqual([["workspace", "Platform3 projects"], ["project", "code-foundryFresh copy"], ["branch", "feat/sidebar"]]);
  });

  it("a thread in its workspace's folder: the workspace, then the folder, no branch", () => {
    const ws = addWorkspace("Platform", ["repo-cf", "repo-gp"]);
    child({ projectId: "", worktreePath: ws.managedDir, workspaceId: ws.id, projectIds: ["repo-cf", "repo-gp"], branch: "feat/x" });
    expect(place(open("c"))).toEqual([["workspace", "Platform2 projects"], ["project", "Workspace folder"]]);
  });

  it("uses the app's icons: Layers, the project's kind, GitBranch with the branch in mono; House for no project", () => {
    const ws = addWorkspace("Platform", ["repo-cf", "repo-gp"]);
    child({ worktreePath: FEAT, createdWorktree: true, workspaceId: ws.id, projectIds: ["repo-cf", "repo-gp"] });
    const card = open("c");
    expect(within(card).getByTestId("tip-workspace").querySelector("svg.lucide-layers")).not.toBeNull();
    expect(within(card).getByTestId("tip-project").querySelector("svg")).not.toBeNull();
    expect(within(card).getByTestId("tip-project").querySelector("svg.lucide-folder")).toBeNull();
    expect(within(card).getByTestId("tip-branch").querySelector("svg.lucide-git-branch")).not.toBeNull();
    expect(within(within(card).getByTestId("tip-branch")).getByText("feat/sidebar").className).toContain("font-mono");
    cleanup();
    child({ projectId: "", projectIds: [], worktreePath: HOME });
    expect(within(open("c")).getByTestId("tip-project").querySelector("svg.lucide-house")).not.toBeNull();
  });

  it.each<[string, Partial<ThreadView>, number]>([
    ["once, in the place rows, in a fresh copy", { worktreePath: FEAT, createdWorktree: true, branch: "feat/sidebar" }, 1],
    ["not at all in the project's folder", { worktreePath: CF, branch: "feat/sidebar" }, 0],
  ])("a child's branch shows %s", (_name, o, want) => {
    child(o);
    expect(open("c").textContent.split("feat/sidebar")).toHaveLength(want + 1);
  });

  it("a run shows no place: the daemon records none, and its thread's could be wrong", () => {
    useThreadsStore.setState({ byId: { "s-r1": thread("s-r1", { state: "connected", worktreePath: FEAT, createdWorktree: true }) }, order: ["s-r1"] });
    useThreadStore.setState({ logs: { "s-r1": { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: RUNS } } });
    render(<LineageGroup threadId="s-r1" />);
    const card = open("a1");
    expect(card.textContent).toContain("general-purpose");
    expect(within(card).queryByTestId("ti-lineage-place")).toBeNull();
    expect(within(card).queryByTestId("tip-project")).toBeNull();
  });

  it("a child shows its own place, not its creator's", () => {
    const lead = thread("lead", { state: "connected", worktreePath: FEAT, createdWorktree: true });
    const c = thread("c", { createdBy: "lead", state: "connected", status: "busy", projectId: "repo-gp", worktreePath: `${HOME}/src/ghostty-playground` });
    useThreadsStore.setState({ byId: { lead, c }, order: ["lead", "c"] });
    useThreadStore.setState({ logs: {} });
    render(<LineageGroup threadId="lead" />);
    expect(place(open("c"))).toEqual([["project", "ghostty-playgroundProject folder"]]);
  });

  it("mounts only while the card is open", () => {
    child({ worktreePath: FEAT, createdWorktree: true });
    expect(document.querySelector('[data-testid="tip-project"]')).toBeNull();
    open("c");
    expect(document.querySelector('[data-testid="tip-project"]')).not.toBeNull();
  });
});
