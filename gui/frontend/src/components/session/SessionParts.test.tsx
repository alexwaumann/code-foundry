import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { SessionView } from "@/api/session";
import { useCommandsStore } from "@/stores/commands";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { SessionTitle } from "./SessionParts";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));

const cmd = (name: string): CommandView => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });

const thread = (o: Partial<SessionView>) =>
  ({ id: "s-1", name: "Fix the stale PR badge", repoId: "cf", worktreePath: "/src/cf.worktrees/pr-badge", workspaceId: "", pendingWorktreePath: "", state: "connected", status: "idle", model: "opus", effort: "high", linkedPullRequests: [], ...o }) as SessionView;

type Worktree = { path: string; branch: string; head: string; isMain?: boolean };
function repo(name: string, worktrees: Worktree[], git = true) {
  return { id: name, name, git, worktrees } as unknown as ReturnType<typeof useReposStore.getState>["byId"][string];
}

beforeEach(() => {
  useCommandsStore.setState({ commands: [cmd("thread.rename"), cmd("view.panel.worktree")] });
  useReposStore.setState({
    byId: {
      cf: repo("code-foundry", [
        { path: "/src/cf", branch: "main", head: "abc", isMain: true },
        { path: "/src/cf.worktrees/pr-badge", branch: "cf/pr-badge-stale", head: "def", isMain: false },
      ]),
      notes: repo("scratch notes", [{ path: "/src/notes", branch: "", head: "", isMain: true }], false),
    },
    order: ["cf", "notes"],
  });
  useSessionsStore.setState({ byId: { "s-1": thread({}) }, order: ["s-1"] });
});

afterEach(() => {
  cleanup();
  startCommandNamed.mockClear();
});

const title = () => screen.getByTestId("thread-title");
const location = () => screen.getByTestId("thread-location");

describe("SessionTitle", () => {
  it("names the thread; a click renames it through session.rename", () => {
    render(<SessionTitle id="s-1" />);
    expect(title().tagName).toBe("BUTTON");
    expect(title().textContent).toBe("Fix the stale PR badge");
    expect(title().getAttribute("title")).toBeNull();
    fireEvent.click(title());
    expect(startCommandNamed).toHaveBeenCalledWith("thread.rename");
  });

  it("shows no status, badge text, model or path", () => {
    render(<SessionTitle id="s-1" />);
    const text = document.body.textContent;
    expect(text).not.toContain("opus");
    expect(text).not.toContain("Connected");
    expect(text).not.toContain("/src/cf");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    ["a linked worktree: project @ branch and the worktree chip", "/src/cf.worktrees/pr-badge", "cf", "code-foundry@cf/pr-badge-staleworktree", true],
    ["the main checkout: no chip", "/src/cf", "cf", "code-foundry@main", false],
    ["no git: the folder and No git, no branch", "/src/notes", "notes", "scratch notesNo git", false],
  ])("%s", (_name, worktreePath, repoId, text, chip) => {
    useSessionsStore.setState({ byId: { "s-1": thread({ worktreePath, repoId }) } });
    render(<SessionTitle id="s-1" />);
    expect(location().textContent).toBe(text);
    expect(screen.queryByTestId("thread-worktree-chip") !== null).toBe(chip);
    expect(screen.queryByTestId("thread-branch") === null).toBe(repoId === "notes");
    expect(screen.queryByTestId("no-git-badge") !== null).toBe(repoId === "notes");
  });

  it("opens the worktree surface through view.panel.worktree; plain text where it is unavailable", () => {
    render(<SessionTitle id="s-1" />);
    expect(location().tagName).toBe("BUTTON");
    expect(location().getAttribute("title")).toBeNull();
    fireEvent.click(location());
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.worktree");
    cleanup();

    useCommandsStore.setState({ commands: [] });
    render(<SessionTitle id="s-1" />);
    expect(location().tagName).toBe("SPAN");
    expect(location().textContent).toBe("code-foundry@cf/pr-badge-staleworktree");
    expect(title().tagName).toBe("SPAN");
    expect(title().textContent).toBe("Fix the stale PR badge");
  });

  it("no project: the House icon and No project, no branch or chip, plain text without view.panel.worktree", () => {
    useCommandsStore.setState({ commands: [cmd("thread.rename")] });
    useSessionsStore.setState({ byId: { "s-1": thread({ repoId: "", worktreePath: "/Users/dev" }) } });
    render(<SessionTitle id="s-1" />);
    expect(location().tagName).toBe("SPAN");
    expect(location().textContent).toBe("No project");
    expect(location().querySelector("svg.lucide-house")).not.toBeNull();
    expect(screen.queryByTestId("thread-branch")).toBeNull();
    expect(screen.queryByTestId("thread-worktree-chip")).toBeNull();
  });

  it("an unnamed thread shows its id", () => {
    useSessionsStore.setState({ byId: { "s-1": thread({ name: "" }) } });
    render(<SessionTitle id="s-1" />);
    expect(title().textContent).toBe("s-1");
  });
});
